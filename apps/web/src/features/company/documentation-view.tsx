'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/cn';
import { CrmView } from './crm-view';
import { DevelopersView } from './developers-view';
import { ApiDocsView } from './api-docs-view';
import { WhishDocsView } from './whish-docs-view';

// One "Documentation" hub with tabs. Each tab is the existing view,
// unchanged — only the active one mounts.
const TABS = [
  { id: 'whish', label: 'Whish Pay', Component: WhishDocsView },
  { id: 'crm', label: 'CRM', Component: CrmView },
  { id: 'developers', label: 'Developers', Component: DevelopersView },
  { id: 'api', label: 'API Docs', Component: ApiDocsView },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function DocumentationView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const active = TABS.find((t) => t.id === params.get('tab')) ?? TABS[0];
  const ActivePanel = active.Component;

  function select(id: TabId) {
    // First tab is the default → keep the URL clean.
    router.replace(pathname + (id === TABS[0].id ? '' : `?tab=${id}`), { scroll: false });
  }

  return (
    <div className="space-y-6">
      <div role="tablist" className="flex gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === active.id}
            onClick={() => select(t.id)}
            className={cn(
              '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors',
              t.id === active.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <ActivePanel />
    </div>
  );
}
