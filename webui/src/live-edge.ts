// webui/src/live-edge.ts
//
// Where live output is scrolled -- the one thing about a transcript or activity
// stream that cannot be derived from props. The decision is a pure predicate
// over the three numbers any scroller reports, so it is testable without a DOM
// harness (ADR-0067); the hook around it only reads those numbers and writes
// scrollTop.

import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

/**
 * How close to the bottom still counts as standing at the live edge. Fractional
 * device pixel ratios and a last turn scrolled a hair short of the end both land
 * inside it, so an operator who never scrolled keeps following the conversation.
 */
export const LIVE_EDGE_TOLERANCE_PX = 32;

/** The scroll geometry of a scroller, as the element itself reports it. */
export interface ScrollPosition {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
}

export type LiveEdgeIdentity = string | null;

export interface LiveEdgeOptions {
	observeResize?: boolean;
}

type ResizeObserverConstructor = new (callback: () => void) => {
	observe(target: HTMLElement): void;
	disconnect(): void;
};

function resizeObserverConstructor(): ResizeObserverConstructor | undefined {
	return (globalThis as unknown as { ResizeObserver?: ResizeObserverConstructor }).ResizeObserver;
}

/** Whether this position is close enough to the bottom to keep following. */
export function isAtLiveEdge(position: ScrollPosition): boolean {
	const distance = position.scrollHeight - position.scrollTop - position.clientHeight;
	return distance <= LIVE_EDGE_TOLERANCE_PX;
}

/** Whether a scroller away from its live edge needs a return control. */
export function canReturnToLiveEdge(position: ScrollPosition): boolean {
	return position.scrollHeight > position.clientHeight && !isAtLiveEdge(position);
}

/** The DOM-independent state machine shared by every live output region. */
export interface LiveEdgeController {
	onScroll(position: ScrollPosition): void;
	onArrival(position: ScrollPosition): void;
}

export function createLiveEdgeController(): LiveEdgeController {
	let following = true;
	return {
		onScroll(position) {
			following = isAtLiveEdge(position);
		},
		onArrival(position) {
			if (following) position.scrollTop = position.scrollHeight;
		},
	};
}

export interface LiveEdgeSession {
	identity: LiveEdgeIdentity;
	controller: LiveEdgeController;
}

/** Replace reader state synchronously whenever a live region's identity changes. */
export function liveEdgeSession(
	current: LiveEdgeSession | null,
	identity: LiveEdgeIdentity,
): LiveEdgeSession {
	return current?.identity === identity
		? current
		: { identity, controller: createLiveEdgeController() };
}

/**
 * The three numbers this module needs, read off the mounted element. This is
 * the file's entire dependency on the DOM: the repository typecheck compiles it
 * without the DOM lib -- it arrives there through the test that exercises the
 * predicate -- and nothing here wants an element beyond this shape.
 */
function positionOf(node: HTMLElement | null): ScrollPosition | null {
	return node as unknown as ScrollPosition | null;
}

/**
 * Opens the scroller at its newest content and follows every later arrival --
 * but only while the operator is still standing at the live edge. Once they
 * scroll up to read history the follow stops, and it resumes the moment they
 * come back down. `newest` is whatever identifies the last item: the effect
 * fires when it changes, which is exactly when something arrived.
 */
export function useLiveEdge<Element extends HTMLElement = HTMLElement>(
	newest: number | null,
	identity: LiveEdgeIdentity = null,
	options: LiveEdgeOptions = {},
): {
	ref: RefObject<Element | null>;
	onScroll: () => void;
	role: 'log';
	tabIndex: 0;
	canReturnToLiveEdge: boolean;
	returnToLiveEdge: () => void;
} {
	const ref = useRef<Element | null>(null);
	const session = useRef<LiveEdgeSession | null>(null);
	const [canReturn, setCanReturn] = useState(false);
	// This must happen during render, including renders where the region has no
	// mounted node. A run-1 -> null -> run-1 sequence needs fresh reader state.
	session.current = liveEdgeSession(session.current, identity);
	const updateReturnControl = useCallback((position: ScrollPosition): void => {
		setCanReturn(canReturnToLiveEdge(position));
	}, []);
	const onScroll = useCallback(() => {
		const position = positionOf(ref.current);
		if (position !== null) {
			session.current?.controller.onScroll(position);
			updateReturnControl(position);
		}
	}, [updateReturnControl]);
	const returnToLiveEdge = useCallback(() => {
		const position = positionOf(ref.current);
		if (position === null) return;
		position.scrollTop = position.scrollHeight;
		session.current?.controller.onScroll(position);
		updateReturnControl(position);
	}, [updateReturnControl]);
	useEffect(() => {
		const position = positionOf(ref.current);
		if (position !== null) {
			session.current?.controller.onArrival(position);
			updateReturnControl(position);
		}
	}, [newest, identity, updateReturnControl]);
	useEffect(() => {
		if (!options.observeResize) return;
		const node = ref.current;
		const ResizeObserver = resizeObserverConstructor();
		if (node === null || ResizeObserver === undefined) return;
		const observer = new ResizeObserver(() => {
			const position = positionOf(ref.current);
			if (position !== null) {
				session.current?.controller.onScroll(position);
				updateReturnControl(position);
			}
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, [options.observeResize, updateReturnControl]);
	// Keep the observable region semantics and the invisible scroll bindings
	// atomic: a consumer either attaches the complete live-edge contract or none
	// of it.
	return {
		ref,
		onScroll,
		role: 'log',
		tabIndex: 0,
		canReturnToLiveEdge: canReturn,
		returnToLiveEdge,
	};
}
