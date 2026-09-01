// webui/src/components/ui/table.tsx
//
// coss ui's table, vendored verbatim (packages/ui/src/components/table.tsx,
// operator decision 2026-08-25): a scroll container wrapping the real
// <table>, rows separated by the border token, hover and selection tinted
// by mixing the surface with 2-4% of ink. The "card" variant's selectors
// ride along verbatim but stay inert; every table on this screen renders
// the default variant. Only the exports this screen consumes are kept.

import type React from 'react';
import { cn } from '../../lib/cn.ts';

export function Table({
	className,
	...props
}: React.ComponentProps<'table'>): React.ReactElement {
	return (
		<div className="relative w-full overflow-x-auto" data-slot="table-container" data-variant="default">
			<table
				className={cn(
					'w-full caption-bottom in-data-[variant=card]:border-separate in-data-[variant=card]:border-spacing-0 text-sm',
					className,
				)}
				data-slot="table"
				{...props}
			/>
		</div>
	);
}

export function TableHeader({
	className,
	...props
}: React.ComponentProps<'thead'>): React.ReactElement {
	return <thead className={cn('[&_tr]:border-b', className)} data-slot="table-header" {...props} />;
}

export function TableBody({
	className,
	...props
}: React.ComponentProps<'tbody'>): React.ReactElement {
	return (
		<tbody
			className={cn('relative [&_tr:last-child]:border-0', className)}
			data-slot="table-body"
			{...props}
		/>
	);
}

export function TableRow({
	className,
	...props
}: React.ComponentProps<'tr'>): React.ReactElement {
	return (
		<tr
			className={cn(
				'relative border-b hover:bg-[color-mix(in_srgb,var(--background),var(--color-black)_2%)] ' +
					'data-[state=selected]:bg-[color-mix(in_srgb,var(--background),var(--color-black)_4%)] ' +
					'dark:data-[state=selected]:bg-[color-mix(in_srgb,var(--background),var(--color-white)_4%)] ' +
					'dark:hover:bg-[color-mix(in_srgb,var(--background),var(--color-white)_2%)]',
				className,
			)}
			data-slot="table-row"
			{...props}
		/>
	);
}

export function TableHead({ className, ...props }: React.ComponentProps<'th'>): React.ReactElement {
	return (
		<th
			className={cn(
				'h-10 whitespace-nowrap px-2.5 text-left align-middle font-medium text-muted-foreground leading-none',
				className,
			)}
			data-slot="table-head"
			{...props}
		/>
	);
}

export function TableCell({ className, ...props }: React.ComponentProps<'td'>): React.ReactElement {
	return (
		<td
			className={cn(
				'whitespace-nowrap bg-clip-padding p-2.5 align-middle leading-none',
				className,
			)}
			data-slot="table-cell"
			{...props}
		/>
	);
}
