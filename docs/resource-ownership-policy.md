# Content and resource capacity

Bear keeps limits on domains it owns: Explicit Memory, Character/Display documents, pagination, diagnostic retention, and presentation summaries. Explicit Memory remains 4,000 characters. Character/Display schema and document limits remain authoritative for their own fields.

Pi owns conversation content and execution. Bear passes messages, queue contents, native events, and available version leaves without adding content-length or queue-capacity quotas. The transport still requires serializable values. Model and provider capabilities remain upstream decisions.

External executor instructions and public evidence pass through without Bear-added content, event-count, or output-file quotas. Bear continues to redact credentials and internal paths, validate ownership, and verify captured output integrity. Presentation summaries and read pages are distinct from full evidence and files.

Character ZIP files are uploaded in 1 MiB transport chunks using opaque upload ids. Chunk size bounds working memory rather than accepted package size. The Host uses the bundled yauzl reader and Node streams to extract ZIP/ZIP64 entries to a private staging directory, checks CRC and paths, and installs through CharacterLoader's durable package transaction. Host shutdown disposes upload resources; the next import service initialization clears abandoned staging from a previous process. The UI carries neither authoritative host paths nor the whole expanded package. Unsupported codecs, encrypted ZIPs, filesystem errors, and disk exhaustion remain explicit failures.

Programmatic file-list imports and character draft operations share CharacterLoader's validation and installation authority. They have no Bear file-count or content-size quotas; callers handling large archives should use the streaming archive endpoints. Media has no Bear byte-size or item-count quota. Underlying runtime and decoder capabilities still apply.

Canon is Bear-owned. A manual source accepts up to 16 × 1024 × 1024 characters; a curated module can reference up to 10,000 chunks. The chunker retains its 1,600-character target. These limits support book-sized sources and curated collections while keeping a single synchronous ingestion/edit bounded. Search relevance limits and cursor-based page sizes remain separate from stored collection size.
