// webui/src/components/ui/progress.tsx
//
// A determinate progress bar, whole: its label, its percentage and its track
// are one component taking one value, because the screen has exactly one thing
// to report with it -- how far along the run spine a run is (run-view.ts).
//
// Accessibility is carried by the bar itself: it names itself with the label
// and states its position with aria-valuenow and a spoken aria-valuetext, so
// the visible label and percentage are marked decorative rather than read a
// second time.

import type React from 'react';

export function Progress({
	label,
	value,
}: {
	label: string;
	/** Completed percentage, 0..100. */
	value: number;
}): React.ReactElement {
	const percent = `${value}%`;
	return (
		<div
			aria-label={label}
			aria-valuemax={100}
			aria-valuemin={0}
			aria-valuenow={value}
			aria-valuetext={percent}
			className="flex w-full flex-col gap-2"
			data-slot="progress"
			role="progressbar"
		>
			<div aria-hidden="true" className="flex items-baseline justify-between">
				<span className="font-medium text-sm" data-slot="progress-label">
					{label}
				</span>
				<span className="text-sm tabular-nums" data-slot="progress-value">
					{percent}
				</span>
			</div>
			<div
				className="h-1.5 w-full overflow-hidden rounded-full bg-input"
				data-slot="progress-track"
			>
				<div
					className="h-full bg-primary transition-[width] duration-500"
					data-slot="progress-indicator"
					style={{ width: percent }}
				/>
			</div>
		</div>
	);
}
