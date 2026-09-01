// webui/src/components/ui/button.tsx
//
// Gateship's button uses the Base UI primitive with rounded controls,
// with an inner bevel, a top gloss and a fill-tinted shadow on the solid
// variants, both flattening on press. The loading machinery is omitted (no
// call site uses it and it would pull in an icon package); the class strings
// that reference it are inert without the indicator element.
//
// The `attention` variant is the acid form of the
// solid button, reserved for actions that resolve an item waiting on the
// operator; and the focus ring, which stays the acid --ring token.

import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/cn.ts';

export const buttonVariants = cva(
	/* The generous curve echoes the wordmark arch. */
	'relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-xl border font-medium text-base outline-none transition-[box-shadow,transform] duration-100 active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100 ' +
		'before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-xl)-1px)] ' +
		'pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 ' +
		'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ' +
		'disabled:pointer-events-none disabled:opacity-64 sm:text-sm ' +
		"[&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 " +
		'[&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0',
	{
		defaultVariants: {
			size: 'default',
			variant: 'default',
		},
		variants: {
			size: {
				default: 'h-9 px-[calc(--spacing(3)-1px)] sm:h-8',
				icon: 'size-9 sm:size-8',
				lg: 'h-10 px-[calc(--spacing(3.5)-1px)] sm:h-9',
				sm: 'h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:h-7',
			},
			variant: {
				default:
					'not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] border-primary bg-primary text-primary-foreground shadow-primary/24 shadow-xs hover:bg-primary/90 data-pressed:bg-primary/90 [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none',
				/* Gateship's acid form of the solid button; the gloss is stronger
				 * because the fill is light. */
				attention:
					'not-disabled:inset-shadow-[0_1px_--theme(--color-white/32%)] border-attention bg-attention text-attention-foreground shadow-attention/24 shadow-xs hover:bg-attention/90 data-pressed:bg-attention/90 [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none',
				destructive:
					'not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] border-destructive bg-destructive text-white shadow-destructive/24 shadow-xs hover:bg-destructive/90 data-pressed:bg-destructive/90 [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none',
				ghost:
					'border-transparent text-foreground hover:bg-accent data-pressed:bg-accent',
				/* Raised controls stay white on light and use the input tint on dark. */
				outline:
					'border-input bg-white not-dark:bg-clip-padding text-foreground shadow-xs/5 not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] hover:bg-accent/50 data-pressed:bg-accent/50 dark:bg-input/32 dark:data-pressed:bg-input/64 dark:hover:bg-input/64 dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] [:disabled,:active,[data-pressed]]:shadow-none',
				secondary:
					'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/90 data-pressed:bg-secondary/90 [:active,[data-pressed]]:bg-secondary/80',
			},
		},
	},
);

/*
 * Base UI also accepts a state-dependent className function; this screen only
 * ever passes strings, so the prop is narrowed to what `cn` composes.
 */
export function Button({
	className,
	variant = 'default',
	size = 'default',
	...props
}: Omit<ButtonPrimitive.Props, 'className'> & { className?: string } & VariantProps<
	typeof buttonVariants
>): React.ReactElement {
	return (
		<ButtonPrimitive
			data-slot="button"
			className={cn(buttonVariants({ variant, size }), className)}
			{...props}
		/>
	);
}
