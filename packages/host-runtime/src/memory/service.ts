/**
 * Compatibility holder for the retired local memory service.
 *
 * Memory persistence and retrieval are owned exclusively by the TencentDB
 * backend. The runtime still constructs this object while the composition
 * context is shared with older host wiring, but no local memory operation is
 * exposed here.
 */
import type { AppDatabase } from "../storage/database.js";
import type { EventBus } from "../storage/event-bus.js";

export interface MemoryServiceOptions {
	/** Injectable clock retained for constructor compatibility. */
	msToNow?: () => Date;
}

export class MemoryService {
	constructor(_db: AppDatabase, _eventBus: EventBus, _options?: MemoryServiceOptions) {}
}
