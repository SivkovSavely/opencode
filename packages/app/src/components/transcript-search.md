# Transcript Search Contract

The global titlebar action and `transcript.search` command open
`DialogTranscriptSearch`. Each server searches its own persisted transcript
database; the Web UI can aggregate selected servers and keeps server identity on
each result.

## Search and indexing

Search candidates come from legacy message parts and the durable V2 message
projection. Hidden queue placeholders, synthetic/ignored content, reasoning,
internal tool metadata, and attachment payloads are excluded. Search is bounded
to the first 65,536 characters of each content category. The dialog shows when
the incremental index is incomplete and when a result category is truncated;
`complete` means the bounded indexed corpus has no additional page.
Assistant errors follow timeline visibility: superseded retry errors hidden by
the transcript are not returned as hits.

Literal queries of at least three Unicode characters are case-insensitive
substring searches. `/pattern/flags` uses a bounded regex subset: literals,
escapes, dots, character classes, and anchors; groups, alternation, quantifiers,
and backreferences are rejected. Regex needs a literal candidate run of at least
three characters so the server can narrow the corpus through SQLite trigram
indexes before evaluating the pattern. Invalid or unsupported patterns return a
visible validation error.

## Filters and facets

The server accepts project, role, category, tool status/name, model/provider,
agent, date, session-kind, archive, and sort filters. Date bounds are inclusive
Unix milliseconds. Tool statuses distinguish running, completed, error, and
explicitly interrupted calls; ordinary assistant errors are a separate content
category. Search facets are discovered from full historical persisted content,
independent of the query page, and include last-used timestamps. The dialog
unions those values with currently available project, model, and agent options.

## Pagination and navigation

Pages use stable keyset ordering by result timestamp or session title, then
message and document identity. New records inserted during a search cannot
reorder already returned rows or create duplicate pages. Each server's next page
is fetched before displaying the next globally sorted cross-server page.

Selecting a hit navigates to its server, project, session, and exact message or
part using a `#search:` hash. The timeline loads older history as needed, expands
collapsed tool groups, scrolls to the message/part, and briefly highlights it.
Legacy `#message-<userID>` links and the session-local Jump-to-message dialog
retain their existing behavior.

## Localization

All static copy uses typed translation keys. New copy currently uses the shared
English fallback for other locales, explicitly listed in the parity test, until
verified translations are available.
