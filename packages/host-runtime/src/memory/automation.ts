/**
 * The legacy text extractor has been removed.
 *
 * Durable memory is created only by an explicit capture or host tool call and
 * is persisted through the TencentDB backend seam. The runtime still owns
 * this lifecycle object for compatibility with its composition wiring; it is
 * intentionally inert and subscribes to no message events.
 */
import type { AppDatabase } from "../storage/database.js";
import type { EventBus } from "../storage/event-bus.js";
import type { MemoryService } from "./service.js";

export class MemoryAutomation {
	constructor(_db: AppDatabase, _eventBus: EventBus, _memory: MemoryService) {}

	dispose(): void {}
}
