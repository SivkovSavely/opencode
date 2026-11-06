import { parseMessageSearch, searchMessages } from "./message-search"

self.onmessage = (event: MessageEvent<{ query: string; items: { id: string; text: string }[] }>) => {
  self.postMessage(searchMessages(event.data.items, parseMessageSearch(event.data.query)))
}
