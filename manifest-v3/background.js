// const isFirefox = chrome.runtime.getURL("").startsWith("moz-extension");
const isFirefox = navigator.userAgent.includes("Firefox");
const SearchIndexURL = 'https://developer.mozilla.org/en-US/search-index.json';
const CacheName = 'mdn';
let TimeoutId = 0;// input debounce timer
let IndexPromise;// a promise resolve to index or null
let isFirstInput = true;

class SearchIndex {
  static initIndexPromise() {
    return new Promise(async function (resolve) {
      let resp = await caches.match(SearchIndexURL);
      if (resp) {
        resolve(SearchIndex.buildIndex(await resp.json()));
      } else {
        // try to fetch data once
        let success = await SearchIndex.refreshJSON();
        if (success) {
          resp = await caches.match(SearchIndexURL);
          resolve(SearchIndex.buildIndex(await resp.json()));
        } else {
          resolve(null);
        }
      }
    });
  }

  static buildIndex(json) {
    return new Fuse(json, {
      includeMatches: true,
      includeScore: true,
      ignoreLocation: true,
      keys: ['title', 'url']
    });
  }

  static getIndex() {
    // There is always only one IndexPromise
    if (!IndexPromise) {
      IndexPromise = SearchIndex.initIndexPromise();
    }
    return IndexPromise;
  }

  /**
   * fetch MDN search index, save it to cache storage.
   */
  static async refreshJSON() {
    try {
      let resp = await fetch(SearchIndexURL);
      if (resp.ok) { // 200-299
        let cache = await caches.open(CacheName);
        await cache.put(SearchIndexURL, resp);
        return true;// success
      }
      // else: 304 not modified, or other server error like 404, 500
    } catch (e) { // network error
      console.error(e);
    }
    return false;// fail or no new data
  }
}

class Omnibox {
  static onInputStarted() {
    isFirstInput = true;
    SearchIndex.getIndex(); // pre-warm index
  }

  static onInputChanged(text, suggest) {
    // optimize(no debounce) for the first input that paste from clipboard
    if (isFirstInput) {
      isFirstInput = false;
      if(text.length > 2) {
        Omnibox.showSuggest(text, suggest);
        return;
      }
    }

    // debounce input
    clearTimeout(TimeoutId);
    TimeoutId = setTimeout(Omnibox.showSuggest, 250, text, suggest);
  }

  /**
   * search index
   */
  static async showSuggest(text, suggest) {
    const index = await SearchIndex.getIndex();
    if (!index) {
      // TODO: show some tip
      return;
    }
    
    let searchResults = index.search(text, { limit: 10 });

    // transform Fuse serach result[] to SuggestResult[]
    let suggestResults = [];
    for (let result of searchResults) {
      // set SuggestResult.content to final url
      let content = `https://developer.mozilla.org${result.item.url}`;

      // SuggestResult.description
      let description;
      if (isFirefox) {
        // Firefox: interpreted as plain text, highlight matches automatically
        description = `${result.item.title}  ➔  ${result.item.url}`;
      } else {
        // Chrome: support xml tags and text must escape xml
        description = Omnibox.highlight(result);
      }

      suggestResults.push({
        content,
        description
      });
    }
    if (suggestResults.length > 0) {
      suggest(suggestResults);
    }
  }

  static highlight(result) {
    let titleMatch, urlMatch;
    for (let m of result.matches) {
      if (m.key == "title") {
        titleMatch = m;
      } else if (m.key == "url") {
        urlMatch = m;
      }
    }
    let title = titleMatch ? Omnibox.highlightMatch(titleMatch) : Omnibox.escapeXml(result.item.title);
    let url = urlMatch ? Omnibox.highlightMatch(urlMatch) : Omnibox.escapeXml(result.item.url);
    return `${title}  ➔  <url>${url}</url>`;
  }

  /**
   * Chrome support xml tags: url/match/dim .
   * text must escape the five predefined entities.
   */
  static highlightMatch(match) {
    let result = [];
    // step 1: escape xml char
    for (let char of match.value) {
      switch (char) {
        case '<': result.push('&lt;'); break;
        case '>': result.push('&gt;'); break;
        case '&': result.push('&amp;'); break;
        case '\'': result.push('&apos;'); break;
        case '"': result.push('&quot;'); break;
        default: result.push(char);
      }
    }
    // step 2: highlight match
    for (let [from, to] of match.indices) {
      result[from] = `<match>${result[from]}`;
      result[to] = `${result[to]}</match>`;
    }
    return result.join('');
  }

  // source from https://stackoverflow.com/a/27979933/1330598
  static escapeXml(unsafe) {
    return unsafe.replace(/[<>&'"]/g, function (c) {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case '\'': return '&apos;';
        case '"': return '&quot;';
      }
    });
  }

  /**
   * user input enter/cmd+enter, search text
   */
  static onInputEntered(text, disposition) {
    text = text.trim();
    if (!text) {
      return;
    }

    const url = Omnibox.getResultURL(text);

    if (disposition == "currentTab") {
      chrome.tabs.update({ url });
    } else {
      // disposition is "newForegroundTab" or "newBackgroundTab"
      chrome.tabs.create({
        url,
        active: disposition == "newForegroundTab"
      });
    }
  }

  static getResultURL(input) {
    if (input.startsWith('https://developer.mozilla.org/')) {
      return input;
    } else {
      // MDN search template: https://developer.mozilla.org/search?q={searchTerms}
      const url = new URL('https://developer.mozilla.org/search');
      url.searchParams.append('q', input);
      return url.toString();
    }
  }
}

function onInstalled() {
  // first install or update
  SearchIndex.refreshJSON();
  chrome.alarms.create("refresh", {
    periodInMinutes: 2880 // every two days
  });
}

chrome.omnibox.onInputStarted.addListener(Omnibox.onInputStarted);
chrome.omnibox.onInputChanged.addListener(Omnibox.onInputChanged);
chrome.omnibox.onInputEntered.addListener(Omnibox.onInputEntered);
chrome.alarms.onAlarm.addListener(SearchIndex.refreshJSON);
chrome.runtime.onInstalled.addListener(onInstalled);
