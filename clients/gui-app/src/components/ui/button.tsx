import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * Press feedback is the shared `active:press-scrim`, never a per-variant
 * `active:bg-*`. `hover:` is media-gated to hover-capable pointers,
 * so without a press state a control is visually inert for a finger's entire
 * press - but the press state cannot be a color, because the color is not the
 * variant's to choose. Call sites override `hover:bg-*` freely, and `cn()`
 * merges their token over the variant's - but a variant `active:bg-*` has
 * nothing to merge against, so it survives and the control presses into a color
 * it never hovers. The scrim tints whatever color is actually there instead of
 * asserting one; see its definition in `index.css`.
 *
 * `aria-disabled:active:bg-none` on the base suppresses it for controls that
 * stay pointer-reactive on purpose (a disabled-looking control must not answer
 * a press); its attribute selector outranks the scrim's, so the suppression is
 * decided by specificity rather than by emit order. Natively `disabled` ones
 * need no such guard - `disabled:pointer-events-none` below means they never
 * match `:active` at all. The scrim itself is opted into per variant, not put
 * on the base, for the same reason: `link` must not carry it, and a base token
 * could only be cancelled by another `active:` utility of equal specificity,
 * which would leave the outcome to stylesheet order.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-ui-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-disabled:active:bg-none aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground active:press-scrim [a]:hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground active:press-scrim aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 active:press-scrim aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground active:press-scrim aria-expanded:bg-muted aria-expanded:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 active:press-scrim focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        // The one variant with no scrim: a link has no box to tint, so a
        // rectangle blooming behind the text reads as a rendering fault rather
        // than a press. The underline it already uses for hover is the feedback.
        link: "text-primary underline-offset-4 hover:underline active:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-sm px-2 text-ui-xs in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-sm px-2.5 text-ui-sm in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-sm in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 rounded-sm in-data-[slot=button-group]:rounded-md",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button };
