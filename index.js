import { Client } from "@notionhq/client"
import Jikan from 'jikan-node';
import fetch from "node-fetch";
import pkg from 'googleapis';
import _ from "lodash";
const { google } = pkg;

const googleAPIKey = process.env.GOOGLE_API_KEY;
const searchEngineKey = process.env.GOOGLE_SEARCH_ENGINE_KEY;
const customsearch = google.customsearch('v1');

const OPERATION_BATCH_SIZE = 10

/**
 * Prevent rate limiting error.
 */
const delay = retryCount =>
  new Promise(resolve => setTimeout(resolve, 2 ** retryCount));

let MAX_RETRIES = 16;
async function expBackoff(f, callback, retries = 0, lastError = null) {
	if (retries > MAX_RETRIES) throw new Error(lastError);

	let catchf = async function(e) {
		console.log(e);
		console.log(`Retry number ${retries}`);
		await delay(retries);
		return expBackoff(f, callback, retries + 1, e);
	}

	try {
		let r = await f();
		callback(r);
	} catch (error) {
		catchf(error);
	}
}

/**
 * Jikan API calls.
 */
const mal = new Jikan();
let findAnime = async function(id, retries = 0) {
	try {

		let r = await mal.findAnime(id);
		return r;
	} catch (e) {
		if (typeof e !== 'string' && !(e instanceof Array)) {
			return undefined;
		}
		if (e.includes('429') || e.includes('503')) {
			await delay(retries);
			return findAnime(id, retries + 1);
		} else {
			console.error(`Error finding anime with id ${id}`);
			return undefined;
		}
	}
}

let findManga = async function(id, retries = 0) {
	try {

		let r = await mal.findManga(id);
		return r;
	} catch (e) {
		if (e.includes('429') || e.includes('503')) {
			await delay(retries);
			return findManga(id, retries + 1);
		} else {
			console.log(e)
			console.error(`Error finding manga with id ${id}`);
			return undefined;
		}
	}
}
/**
 * End Jikan API calls.
 */

/**
 * Helpers for parsing MAL data.
 */
function getIDfromURL(url) {
	let split = url.split("/");
	let id = parseInt(split.at(-2));
	return isNaN(id) ? undefined : id;
}

function getDuration(durationString, mediaType) {
	if (!durationString) {
		return 90;
	}
	let split = durationString.split(" ");
	if (mediaType === "Movie") {
		return 60 * parseInt(split.at(0)) + parseInt(split.at(2));
	} else {
		return parseInt(split.at(0));
	}
}

function getSequels(data) {
	if (data.related) {
		return data.related.Sequel;
	} else if (data.Sequel) {
		return data.Sequel;
	} else {
		return undefined;
	}
}

async function getMALData(id, mediaType) {
	let data = undefined;
	let isManga = mediaType == "Manga";
	// Allow for retries with MAL API recursive wrapper
	if (isManga) {
		data = await findManga(id);
	} else {
		data = await findAnime(id);
	}
	return data;
}
/**
 * Do MAL query, unpack the data, and prepare for notion data format.
 */
async function getDataFromMyAnimeList(id, mediaType, skipSequel) {
	const mal = new Jikan();
	let data = await getMALData(id, mediaType);
	
	if (!data) {
		return {};
	}

	let isManga = mediaType == "Manga";

	// Get metadata
	let genres = data.genres.map(genre => genre.name)
	let demographics = data.demographics.map(demo => demo.name)
	let type = data.type
	let duration = getDuration(data.duration, type)

	// Cumulative tracking
	let numSequels = 0
	let numEps = !isManga ? data.episodes : data.volumes;
	let totalTime = duration * numEps;
	let status = data.status
	let score = data.score

	let sequels = getSequels(data)
	let sequelNames = "";

	// Linked list traversal of sequel data to get latest air status
	// average rating, and number of episodes.
	if (skipSequel && sequels) {
		for (let i = 0; i < sequels.length; i++) {
			let sequel = sequels[i];
			if (i == 0) {
				sequelNames += sequel.name;
			} else {
				sequelNames += ", " + sequel.name;
			}
		}
	} else {
		while (sequels && sequels.length > 0) {
			let allSequels = [];
			for (const sequel of sequels) {
				if (!sequel) {
					sequels = [];
					break;
				}
				let seqData = await getMALData(sequel.mal_id, mediaType);
				allSequels = allSequels.concat(getSequels(seqData));
				console.log(seqData.title)
				if (seqData.type != "TV" && seqData.type != "Manga") { // Ignore movies and OVAs
					console.log("Skipping...")
					continue;
				}
				// Get total number of sequels and build list of sequel names
				numSequels++;
				sequelNames += numSequels == 1 ? seqData.title : ", " + seqData.title

				let seqNum = !isManga ? seqData.episodes : seqData.volumes;
				let seqDur = getDuration(seqData.duration, seqData.type)
				if (!skipSequel) {
					// Get latest status
					status = seqData.status
				}
				if (seqNum && seqDur) {
					// Add to total time and number of episodes
					totalTime += seqNum * seqDur;
					numEps += seqNum;
				} 
				
				// Get average score
				if (seqData.score) {
					score += seqData.score
				}
				break;
			}

			sequels = allSequels
		}
	}
	

	if (numSequels > 0) {
		score /= (numSequels + 1)
	}
	
	// Pack for notion properties
	return new Promise((resolve, reject) => {
        resolve({
		"Total" : {
			number : numEps,
		},

		"Duration" : {
			number : duration,
		},

	    "Airing Status": {
	      select: { name: status },
	    },

	    "Web Rating" : {
	    	number: score / 2,
	    },

	    "MyAnimeList ID": {
	      number: id,
	    },
	    "Genre": {
	    	multi_select: genres.map( (genre_name) => { return { name: genre_name }; } )
	    },
	    "Sequel Titles" : {
	    	rich_text: [
	    		{
	    			text: {
	    				content: sequelNames
	    			}
	    		}
	    	]
	    },
	    "Skip" : {
	    	checkbox: false
	    }
  	});
    });
}


let googleAPICalls = 0;
/**
 *  Enforce that getAnimeData is done after google search gets the URL.
 */
async function getAnimeData(item, callback) {
	let [notionID, inputID, mediaType, nameAnime, sequelTitles, skip, cleaned, skipSequel] = Object.values(item);
	console.log(skipSequel)
	let inputTitle = nameAnime.concat(" " + mediaType).concat(" MyAnimeList");

	/**
	 *  Make call to google API and track number of API calls for exponential backoff.
	 */
	let doGoogleSearchForMalID = function() {
		googleAPICalls += 1;
		return customsearch.cse.list({ auth:googleAPIKey, cx: searchEngineKey, q: inputTitle });
	};

	/**
	 *  Make call to getAnimeList retrieval when google search results become available.
	 */
	async function onGetGoogleSearchMalID(result) {
		let parsedID = undefined;
		let url = undefined;
		if (result) {
			for (const search_res of result.data.items) {
				if (search_res.link.includes("myanimelist.net")) {
					parsedID = getIDfromURL(search_res.link);
					if (parsedID) {
						url = search_res.link;
						break; // Found a MAL URL that matches criteria.
					}
				}
			}
		}
		let id = undefined;
		if (!parsedID) {
			id = inputID;
			url = "Skipped Google search for URL";
		} else {
			id = parsedID;
		}
		
		if (id) {
			let res = await getDataFromMyAnimeList(id, mediaType, skipSequel);
			console.log(
				"========================================\n" + 
				"Results for " + nameAnime +
				"\n========================================\n" + 
				"\nNotion ID:" + notionID + 
				"\nMedia Type: " + mediaType +
				"\nURL: " + url +
				"\nMyAnimeListID: " + id  
				+ "\nProperties:" + JSON.stringify(res, null, 2) +
				"\n========================================\n"
			);

			// Custom call back when the results are available from MAL.
			callback(res);
		} else {
			console.log(
				"========================================\n" + 
				"Couldn't get ID for anime: " + nameAnime +
				"\n========================================\n"
			);
		}
	}


	// If we have an id, don't retrieve ID from google search results
	expBackoff(inputID ? function() {} : doGoogleSearchForMalID, onGetGoogleSearchMalID);
}

// Notion set up
const notion = new Client({ auth: process.env.NOTION_KEY })
const databaseId = process.env.NOTION_DATABASE_ID

/**
 * Query database and unpack the object's values for use and look up.
 */
async function getItemsFromNotionDatabase() {
  const pages = []
  let cursor = undefined
  while (true) {
    const { results, next_cursor } = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
    })
    pages.push(...results)
    if (!next_cursor) {
      break
    }
    cursor = next_cursor
  }
  console.log(`${pages.length} items successfully fetched.`)
  function packProperties(page) {
  	function unpack(page, propName, unpackCallback) {
  		const prop = page.properties[propName];
  		if (!prop) {
  			return undefined;
  		}
  		return unpackCallback(prop);
  	}
  	function getTitle(prop) {
  		if (!prop.title.length > 0) {
  			return undefined;
  		}
  		return prop.title[0].plain_text;
  	}
  	/**
  	 * Unpack text properties.
  	 */
  	function getRichText(prop) {
  		const rich_text = prop.rich_text
  		if (rich_text.length > 0) {
  			return rich_text[0].text.content;
  		} else {
  			return undefined;
  		}
  	}
  	/**
  	 * Unpack checkbox properties.
  	 */
  	function getCheckbox(prop) {
  		return prop.checkbox;
  	}
  	/**
  	 * Unpack select properties.
  	 */
  	function getSelection(prop) {
  		if (!prop.select) {
  			return undefined;
  		}
  		return prop.select.name;
  	}
  	/**
  	 * Unpack number properties.
  	 */
  	function getNumber(prop) {
  		return prop.number;
  	}

  	return {
      pageId: page.id,
      animeListID: unpack(page, "MyAnimeList ID", getNumber),
      mediaType: unpack(page, "Type", getSelection),
      name: unpack(page, "Name", getTitle), 
      sequelTitles: unpack(page, "Sequel Titles", getRichText), // Compile list of sequel titles to know where total episode count comes from
      skip: unpack(page, "Skip", getCheckbox), // Skip if processed already
      cleaned: unpack(page, "Cleaned", getCheckbox), // MAL results needed manual intervention
      skipSequel: unpack(page, "Skip Sequel Traverse", getCheckbox),
    };
  };
  return pages.map(packProperties)
}

/**
 * Enforce attempt at notion update is after getAnimeData returns.
 */
async function doNotionUpdate(item) {
	return getAnimeData(item, function(propertyVal) {
	    return notion.pages.update({page_id: item.pageId, properties: propertyVal});
	});
	
}

/**
 * Await Notion database responses.
 */
async function updatePages(pagesToUpdate) {
	const pagesToUpdateChunks = _.chunk(pagesToUpdate, OPERATION_BATCH_SIZE)
	for (const pagesToUpdateBatch of pagesToUpdateChunks) {
	    await Promise.all(
      	pagesToUpdate.map((item) => doNotionUpdate(item)
	    )).then(() => {
	    	console.log(`Completed batch size: ${pagesToUpdate.length}`)
	    });
	   
  }
    
}

// ENTRY POINT
// Retrieve items from notion and process in batches
let currentItems = await getItemsFromNotionDatabase();
currentItems = currentItems.filter(item => !item.skip && !item.clean)

const INTERVAL = 15;
let START = 0;
let END = START + INTERVAL * 2;
END = currentItems.length

for (let i = START; i < END; i += INTERVAL)
{
	let items = currentItems.slice(i, i + INTERVAL);
	await updatePages(items);
	let secondsToWait = 15;
	console.log(`Waiting ${secondsToWait} seconds for next batch...`);
	await delay(secondsToWait * 1000);
}

