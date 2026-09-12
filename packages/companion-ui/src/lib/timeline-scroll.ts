const BOTTOM_THRESHOLD_PX = 72;
const USER_SENT_EVENT = "bear-timeline-user-sent";

interface TimelinePosition {
	scrollTop: number;
	following: boolean;
}

export interface TimelineScrollController {
	scrollToLatest(): void;
	preserveReadingPosition(): void;
	dispose(): void;
}

export function installVirtualTimelineFollow(
	timeline: HTMLElement,
	shouldFollow: () => boolean,
): () => void {
	const scrollingElement = document.scrollingElement ?? document.documentElement;
	let frame: number | undefined;
	const follow = () => {
		if (frame !== undefined) cancelAnimationFrame(frame);
		frame = requestAnimationFrame(() => {
			frame = undefined;
			if (shouldFollow())
				scrollingElement.scrollTop = Math.max(
					0,
					scrollingElement.scrollHeight - scrollingElement.clientHeight,
				);
		});
	};
	if (typeof ResizeObserver === "undefined") {
		follow();
		return () => {
			if (frame !== undefined) cancelAnimationFrame(frame);
		};
	}
	const observer = new ResizeObserver(follow);
	observer.observe(timeline);
	follow();
	return () => {
		observer.disconnect();
		if (frame !== undefined) cancelAnimationFrame(frame);
	};
}

export function notifyTimelineUserSent(conversationId: string): void {
	window.dispatchEvent(new CustomEvent(USER_SENT_EVENT, { detail: conversationId }));
}

export function installTimelineScrollProtection(
	timeline: HTMLElement,
	jumpButton: HTMLButtonElement,
	onFollowingChange?: (following: boolean) => void,
	onScrollMeasured?: (conversationId: string, distance: number) => void,
): TimelineScrollController {
	const positions = new Map<string, TimelinePosition>();
	const scrollingElement = document.scrollingElement ?? document.documentElement;
	const userScrollEvents = ["wheel", "touchmove", "pointerup", "keydown"] as const;
	let currentConversationId = timeline.dataset.conversationId;
	let sendFrame: number | undefined;
	let lastMeasurement = "";

	const maxScrollTop = () =>
		Math.max(0, scrollingElement.scrollHeight - scrollingElement.clientHeight);
	const distanceFromBottom = () => Math.max(0, maxScrollTop() - scrollingElement.scrollTop);
	const reportPosition = () => {
		if (!currentConversationId) return;
		const distance = distanceFromBottom();
		const key = `${currentConversationId}:${distance}`;
		if (key === lastMeasurement) return;
		lastMeasurement = key;
		onScrollMeasured?.(currentConversationId, distance);
	};
	const showDetachedState = (following: boolean) => {
		jumpButton.hidden = following;
		onFollowingChange?.(following);
	};
	const capturePosition = () => {
		if (!currentConversationId) return;
		const following = distanceFromBottom() <= BOTTOM_THRESHOLD_PX;
		positions.set(currentConversationId, {
			scrollTop: scrollingElement.scrollTop,
			following,
		});
		showDetachedState(following);
		reportPosition();
	};
	const scrollToLatest = () => {
		scrollingElement.scrollTop = maxScrollTop();
		if (currentConversationId)
			positions.set(currentConversationId, {
				scrollTop: scrollingElement.scrollTop,
				following: true,
			});
		showDetachedState(true);
		reportPosition();
	};
	const preserveReadingPosition = () => {
		if (currentConversationId)
			positions.set(currentConversationId, {
				scrollTop: scrollingElement.scrollTop,
				following: false,
			});
		showDetachedState(false);
	};
	const captureAfterUserScroll = (event: Event) => {
		// Editing/sending is not a request to detach from the latest message.
		// A send can grow the virtual list before its next measured layout.
		if (event.type === "keydown") {
			if (
				!(event instanceof KeyboardEvent) ||
				!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
			)
				return;
			if (
				event.target instanceof Element &&
				event.target.closest("input, textarea, select, button, [contenteditable]")
			)
				return;
		}
		if (
			event.type === "pointerup" &&
			event.target !== document &&
			event.target !== document.documentElement &&
			event.target !== scrollingElement
		)
			return;
		queueMicrotask(capturePosition);
	};
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
		if (event instanceof CustomEvent && event.detail === currentConversationId) {
			scrollToLatest();
			if (sendFrame !== undefined) cancelAnimationFrame(sendFrame);
			sendFrame = requestAnimationFrame(() => {
				sendFrame = undefined;
				synchronize();
			});
		}
	};
	const observer = new MutationObserver(synchronize);
	observer.observe(timeline, {
		attributes: true,
		attributeFilter: ["data-conversation-id"],
	});
	const resizeObserver =
		typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(synchronize);
	resizeObserver?.observe(timeline);
	for (const eventName of userScrollEvents)
		window.addEventListener(eventName, captureAfterUserScroll, { passive: true });
	window.addEventListener(USER_SENT_EVENT, onUserSent);
	scrollToLatest();

	return {
		scrollToLatest,
		preserveReadingPosition,
		dispose: () => {
			if (sendFrame !== undefined) cancelAnimationFrame(sendFrame);
			observer.disconnect();
			resizeObserver?.disconnect();
			for (const eventName of userScrollEvents)
				window.removeEventListener(eventName, captureAfterUserScroll);
			window.removeEventListener(USER_SENT_EVENT, onUserSent);
			positions.clear();
		},
	};
}
