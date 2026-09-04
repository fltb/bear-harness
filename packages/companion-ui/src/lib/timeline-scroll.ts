const BOTTOM_THRESHOLD_PX = 72;
const USER_SENT_EVENT = "bear-timeline-user-sent";

interface TimelinePosition {
	scrollTop: number;
	following: boolean;
}

export interface TimelineScrollController {
	scrollToLatest(): void;
	dispose(): void;
}

export function notifyTimelineUserSent(conversationId: string): void {
	globalThis.dispatchEvent(new CustomEvent(USER_SENT_EVENT, { detail: conversationId }));
}

export function installTimelineScrollProtection(
	timeline: HTMLElement,
	jumpButton: HTMLButtonElement,
): TimelineScrollController {
	const positions = new Map<string, TimelinePosition>();
	let currentConversationId = timeline.dataset.conversationId;

	const distanceFromBottom = () =>
		Math.max(0, timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop);
	const showDetachedState = (following: boolean) => {
		jumpButton.hidden = following;
	};
	const capturePosition = () => {
		if (!currentConversationId) return;
		const following = distanceFromBottom() <= BOTTOM_THRESHOLD_PX;
		positions.set(currentConversationId, { scrollTop: timeline.scrollTop, following });
		showDetachedState(following);
	};
	const scrollToLatest = () => {
		timeline.scrollTop = timeline.scrollHeight;
		if (currentConversationId)
			positions.set(currentConversationId, { scrollTop: timeline.scrollTop, following: true });
		showDetachedState(true);
	};
	const captureAfterUserScroll = () => queueMicrotask(capturePosition);
	const synchronize = () => {
		const conversationId = timeline.dataset.conversationId;
		const conversationChanged = conversationId !== currentConversationId;
		currentConversationId = conversationId;
		if (!conversationId) return;
		if (conversationChanged) {
			const saved = positions.get(conversationId);
			if (!saved || saved.following) scrollToLatest();
			else {
				timeline.scrollTop = Math.min(saved.scrollTop, timeline.scrollHeight);
				showDetachedState(false);
			}
			return;
		}
		const saved = positions.get(conversationId);
		if (saved?.following !== false) scrollToLatest();
		else {
			timeline.scrollTop = Math.min(saved.scrollTop, timeline.scrollHeight);
			showDetachedState(false);
		}
	};
	const onUserSent = (event: Event) => {
		if (event instanceof CustomEvent && event.detail === currentConversationId) scrollToLatest();
	};
	const observer = new MutationObserver(synchronize);
	observer.observe(timeline, {
		attributes: true,
		attributeFilter: ["data-conversation-id"],
		childList: true,
		characterData: true,
		subtree: true,
	});
	for (const eventName of ["wheel", "touchmove", "pointerup", "keydown"])
		timeline.addEventListener(eventName, captureAfterUserScroll, { passive: true });
	globalThis.addEventListener(USER_SENT_EVENT, onUserSent);
	scrollToLatest();

	return {
		scrollToLatest,
		dispose: () => {
			observer.disconnect();
			for (const eventName of ["wheel", "touchmove", "pointerup", "keydown"])
				timeline.removeEventListener(eventName, captureAfterUserScroll);
			globalThis.removeEventListener(USER_SENT_EVENT, onUserSent);
			positions.clear();
		},
	};
}
