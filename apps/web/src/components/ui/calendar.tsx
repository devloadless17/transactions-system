'use client';
import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DayPicker } from 'react-day-picker';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/cn';

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

// shadcn-style wrapper around react-day-picker, themed with our CSS tokens.
export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('p-3', className)}
      classNames={{
        root: 'relative w-fit',
        months: 'flex flex-col gap-4 sm:flex-row sm:gap-6',
        month: 'flex flex-col gap-3',
        month_caption: 'flex h-8 items-center justify-center',
        caption_label: 'text-sm font-medium',
        nav: 'flex items-center gap-1',
        button_previous: cn(
          buttonVariants({ variant: 'outline', size: 'icon' }),
          'absolute left-3 top-3 z-10 h-7 w-7 bg-transparent p-0 opacity-60 hover:opacity-100',
        ),
        button_next: cn(
          buttonVariants({ variant: 'outline', size: 'icon' }),
          'absolute right-3 top-3 z-10 h-7 w-7 bg-transparent p-0 opacity-60 hover:opacity-100',
        ),
        month_grid: 'w-full border-collapse',
        weekdays: 'flex',
        weekday: 'w-9 text-[0.7rem] font-normal text-muted-foreground',
        week: 'mt-1 flex w-full',
        day: cn(
          'relative h-9 w-9 p-0 text-center text-sm',
          '[&:has([aria-selected])]:bg-accent',
          'first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md',
          '[&:has(.rdp-range_start)]:rounded-l-md [&:has(.rdp-range_end)]:rounded-r-md',
        ),
        day_button: cn(
          buttonVariants({ variant: 'ghost' }),
          'h-9 w-9 p-0 font-normal aria-selected:opacity-100',
        ),
        range_start:
          'rdp-range_start rounded-l-md bg-primary [&>button]:bg-primary [&>button]:text-primary-foreground [&>button:hover]:bg-primary [&>button:hover]:text-primary-foreground',
        range_end:
          'rdp-range_end rounded-r-md bg-primary [&>button]:bg-primary [&>button]:text-primary-foreground [&>button:hover]:bg-primary [&>button:hover]:text-primary-foreground',
        selected:
          '[&>button]:bg-primary [&>button]:text-primary-foreground [&>button:hover]:bg-primary [&>button:hover]:text-primary-foreground',
        range_middle:
          'rounded-none bg-accent [&>button]:bg-transparent [&>button]:text-accent-foreground [&>button:hover]:bg-transparent',
        today: '[&>button]:font-semibold [&>button]:underline underline-offset-4',
        outside: 'text-muted-foreground/50',
        disabled: 'text-muted-foreground/40 opacity-50',
        hidden: 'invisible',
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, className: cls }) =>
          orientation === 'left' ? (
            <ChevronLeft className={cn('h-4 w-4', cls)} />
          ) : (
            <ChevronRight className={cn('h-4 w-4', cls)} />
          ),
      }}
      {...props}
    />
  );
}
