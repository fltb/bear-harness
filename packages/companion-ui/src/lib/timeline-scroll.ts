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
	window.dispatchEvent(new CustomEvent(USER_SENT_EVENT, { detail: conversationId }));
}

export function installTimelineScrollProtection(
	timeline: HTMLElement,
	jumpButton: HTMLButtonElement,
): TimelineScrollController {
	const positions = new Map<string, TimelinePosition>();
	const scrollingElement = document.scrollingElement ?? document.documentElement;
	const userScrollEvents = ["wheel", "touchmove", "pointerup", "keydown"] as const;
	let currentConversationId = timeline.dataset.conversationId;

	const maxScrollTop = () =>
		Math.max(0, scrollingElement.scrollHeight - scrollingElement.clientHeight);
	const distanceFromBottom = () => Math.max(0, maxScrollTop() - scrollingElement.scrollTop);
	const showDetachedState = (following: boolean) => {
		jumpButton.hidden = following;
	};
	const capturePosition = () => {
		if (!currentConversationId) return;
		const following = distanceFromBottom() <= BOTTOM_THRESHOLD_PX;
		positions.set(currentConversationId, {
			scrollTop: scrollingElement.scrollTop,
			following,
		});
		showDetachedState(following);
	};
	const scrollToLatest = () => {
		scrollingElement.scrollTop = maxScrollTop();
		if (currentConversationId)
			positions.set(currentConversationId, {
				scrollTop: scrollingElement.scrollTop,
				following: true,
			});
		showDetachedState(true);
	};
	const captureAfterUserScroll = () => queueMicrotask(capturePosition);
	const restorePosition = (position: TimelinePosition) => {
		scrollingElement.scrollTop = Math.min(position.scrollTop, maxScrollTop());
		showDetachedState(false);
	};
	const synchronize = () => {
		const conversationId = timeline.dataset.conversationId;
		const conversationChanged = conversationId !== currentConversationId;
		currentConversationId = conversationId;
		if (!conversationId) {
			showDetachedState(true);
			return;
		}
		const saved = positions.get(conversationId);
		if (conversationChanged) {
			if (!saved || saved.following) scrollToLatest();
			else restorePosition(saved);
			return;
		}
		if (saved?.following !== false) scrollToLatest();
		else restorePosition(saved);
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
	for (const eventName of userScrollEvents)
		window.addEventListener(eventName, captureAfterUserScroll, { passive: true });
	window.addEventListener("scroll", capturePosition, { passive: true });
	window.addEventListener(USER_SENT_EVENT, onUserSent);
	scrollToLatest();

	return {
		scrollToLatest,
		dispose: () => {
			observer.disconnect();
			for (const eventName of userScrollEvents)
				window.removeEventListener(eventName, captureAfterUserScroll);
			window.removeEventListener("scroll", capturePosition);
			window.removeEventListener(USER_SENT_EVENT, onUserSent);
			positions.clear();
		},
	};
}
