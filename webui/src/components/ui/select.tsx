// webui/src/components/ui/select.tsx
//
// coss ui's select, vendored verbatim (packages/ui/src/components/select.tsx,
// operator decision 2026-08-25) on the Base UI select primitive: the trigger
// is the same composed control chrome as Input, the popup is a bordered
// popover with its own hairline bevel and scroll arrows. The glyphs come
// from Hugeicons' free set, the product's icon source (operator decision,
// 2026-08-25). The focus ring stays the acid --ring.
//
// `SelectField` is the one-call form most of this screen needs: items, a
// hidden input via `name` for plain form submission, and the same controlled
// or uncontrolled choice a native select offered.

import { Select as SelectPrimitive } from '@base-ui/react/select';
import { Tick02Icon, UnfoldMoreIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type React from 'react';
import { cn } from '../../lib/cn.ts';

export const Select = SelectPrimitive.Root;

const TRIGGER =
	'relative inline-flex min-h-9 w-full min-w-36 select-none items-center justify-between gap-2 rounded-lg border border-input bg-background not-dark:bg-clip-padding ' +
	'px-[calc(--spacing(3)-1px)] text-left text-base text-foreground shadow-xs/5 outline-none ring-ring/24 transition-shadow ' +
	'before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] ' +
	'not-data-disabled:not-focus-visible:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] ' +
	'pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 ' +
	'focus-visible:border-ring focus-visible:ring-[3px] ' +
	'data-disabled:pointer-events-none data-disabled:opacity-64 sm:min-h-8 sm:text-sm dark:bg-input/32 ' +
	'dark:not-data-disabled:not-focus-visible:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] ' +
	"[&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 " +
	'[&_svg]:pointer-events-none [&_svg]:shrink-0 [[data-disabled],:focus-visible,[data-pressed]]:shadow-none';

export function SelectTrigger({
	className,
	children,
	...props
}: Omit<SelectPrimitive.Trigger.Props, 'className'> & { className?: string }): React.ReactElement {
	return (
		<SelectPrimitive.Trigger className={cn(TRIGGER, className)} data-slot="select-trigger" {...props}>
			{children}
			<SelectPrimitive.Icon data-slot="select-icon">
				<HugeiconsIcon className="-me-1 size-4.5 opacity-80 sm:size-4" icon={UnfoldMoreIcon} size={16} strokeWidth={2.5} />
			</SelectPrimitive.Icon>
		</SelectPrimitive.Trigger>
	);
}

export function SelectValue(props: SelectPrimitive.Value.Props): React.ReactElement {
	return (
		<SelectPrimitive.Value
			className="flex-1 truncate data-placeholder:text-muted-foreground"
			data-slot="select-value"
			{...props}
		/>
	);
}

export function SelectContent({
	className,
	children,
	...props
}: Omit<SelectPrimitive.Popup.Props, 'className'> & { className?: string }): React.ReactElement {
	return (
		<SelectPrimitive.Portal>
			<SelectPrimitive.Positioner
				align="start"
				className="z-50 select-none"
				data-slot="select-positioner"
				side="bottom"
				sideOffset={4}
			>
				<SelectPrimitive.Popup
					className="origin-(--transform-origin) text-foreground outline-none"
					data-slot="select-popup"
					{...props}
				>
					<div className="relative h-full min-w-(--anchor-width) rounded-lg border bg-popover not-dark:bg-clip-padding shadow-lg/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
						<SelectPrimitive.List
							className={cn('max-h-(--available-height) overflow-y-auto p-1', className)}
							data-slot="select-list"
						>
							{children}
						</SelectPrimitive.List>
					</div>
				</SelectPrimitive.Popup>
			</SelectPrimitive.Positioner>
		</SelectPrimitive.Portal>
	);
}

export function SelectItem({
	className,
	children,
	...props
}: Omit<SelectPrimitive.Item.Props, 'className'> & { className?: string }): React.ReactElement {
	return (
		<SelectPrimitive.Item
			className={cn(
				'grid min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-default grid-cols-[1rem_1fr] items-center gap-2 rounded-sm py-1 ps-2 pe-4 text-base outline-none ' +
					'data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm ' +
					"[&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
				className,
			)}
			data-slot="select-item"
			{...props}
		>
			<SelectPrimitive.ItemIndicator className="col-start-1">
				<HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={2.5} />
			</SelectPrimitive.ItemIndicator>
			<SelectPrimitive.ItemText className="col-start-2 min-w-0">{children}</SelectPrimitive.ItemText>
		</SelectPrimitive.Item>
	);
}

/** One option of a SelectField. */
export interface SelectFieldItem {
	value: string;
	label: string;
}

export function SelectField({
	items,
	placeholder,
	id,
	name,
	required,
	disabled,
	value,
	defaultValue,
	onValueChange,
	className,
}: {
	items: readonly SelectFieldItem[];
	placeholder?: string;
	id?: string;
	name?: string;
	required?: boolean;
	disabled?: boolean;
	value?: string;
	defaultValue?: string;
	onValueChange?: (value: string) => void;
	className?: string;
}): React.ReactElement {
	return (
		<Select
			defaultValue={defaultValue}
			disabled={disabled}
			/* The label map lets the trigger render the selected label even
			 * while the popup is unmounted (closed, or static rendering). */
			items={Object.fromEntries(items.map((item) => [item.value, item.label]))}
			name={name}
			onValueChange={onValueChange === undefined ? undefined : (next) => onValueChange(String(next))}
			required={required}
			value={value}
		>
			<SelectTrigger className={className} id={id}>
				<SelectValue placeholder={placeholder} />
			</SelectTrigger>
			<SelectContent>
				{items.map((item) => (
					<SelectItem key={item.value} value={item.value}>
						{item.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
