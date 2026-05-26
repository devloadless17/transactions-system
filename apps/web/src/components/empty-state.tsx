import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Reusable empty-state for tables, lists, and dashboards. Provides a
 * focal icon, a one-line headline, a longer hint, and an optional CTA.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      {Icon && (
        <div className="rounded-full bg-muted p-3">
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>
      )}
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      </div>
      {action && (
        <Button size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
