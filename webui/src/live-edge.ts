// webui/src/live-edge.ts
//
// Where the transcript is scrolled -- the one thing about the conversation that
// cannot be derived from props. The decision is a pure predicate over the three
// numbers any scroller reports, so it is testable without a DOM harness
// (ADR-0067); the hook around it only reads those numbers and writes scrollTop.

import { type RefObject, useCallback, useEffect, useRef } from 'react';

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

/** Whether this position is close enough to the bottom to keep following. */
export function isAtLiveEdge(position: ScrollPosition): boolean {
	const distance = position.scrollHeight - position.scrollTop - position.clientHeight;
	return distance <= LIVE_EDGE_TOLERANCE_PX;
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
export function useLiveEdge(newest: number | null): {
	ref: RefObject<HTMLElement | null>;
	onScroll: () => void;
} {
	const ref = useRef<HTMLElement | null>(null);
	// Mounting counts as standing at the edge: the screen opens at the last turn.
	const following = useRef(true);
	const onScroll = useCallback(() => {
		const position = positionOf(ref.current);
		if (position !== null) following.current = isAtLiveEdge(position);
	}, []);
	useEffect(() => {
		const position = positionOf(ref.current);
		if (position === null || !following.current) return;
		position.scrollTop = position.scrollHeight;
	}, [newest]);
	return { ref, onScroll };
}
