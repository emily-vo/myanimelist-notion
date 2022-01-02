# myanimelist-notion
MyAnimeList data integration with personal Notion database.

##Overview:
Use googles custom search API to get the first result when looking up the anime's title. 
Parses that URL for the MyAnimeList id to pass into the Jikan wrapper MAL requests.
Populates notion database with data from MyAnimeList.
Linked list traversal for accumulation of sequel information. Doesn't work well if sequels are individual entries in the database (may require manual intervention or code tweaking, e.g. Jojo's Bizzare Adventure).
##Set up:
You'll need to get the following developer keys to get this up and running.
```
export NOTION_KEY="YOUR NOTION KEY";
export NOTION_DATABASE_ID="YOUR NOTION DATABASE ID";
export GOOGLE_API_KEY="YOUR GOOGLE API KEY";
export GOOGLE_SEARCH_ENGINE_KEY="YOUR GOOGLE SEARCH ENGINE KEY";
```

###For more information:
**Notion keys:**
https://developers.notion.com/docs/getting-started

**Google API keys:**
https://developers.google.com/maps/documentation/javascript/get-api-key

**Google Search Engine key:**
https://support.google.com/programmable-search/answer/2649143?hl=en

##Troubleshooting:
If you run into rate limiting issues, you can change the interval between batches in the entry point at the bottom of the script. You can also change the batch size.

##Resources and Acknowlegements:
* Alexander Chan for his knowledge on DBs and services.
* https://glitch.com/edit/#!/notion-github-sync for examples on how to use the notion example.
* https://github.com/jikan-me/examples/blob/master/v3/javascript/node_list/index.js for Jikan examples to pull from MyAnimeList.
