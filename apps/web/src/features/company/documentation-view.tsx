'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/cn';
import { GettingStartedView } from './getting-started-view';
import { WhishPayDocsView } from './whish-pay-docs-view';
import { CompanyApiView } from './company-api-view';
import { CrmView } from './crm-view';
import { SourcesApiView } from './sources-api-view';

// One "Documentation" hub. Each tab is a self-contained developer topic, in the
// order you'd meet them: set up, collect, manage, receive events, ingest. Only
// the active tab mounts.
const TABS = [
  { id: 'start', label: 'Getting started', Component: GettingStartedView },
  { id: 'whish', label: 'Whish Pay', Component: WhishPayDocsView },
  { id: 'company', label: 'Company API', Component: CompanyApiView },
  { id: 'crm', label: 'CRM', Component: CrmView },
  { id: 'sources', label: 'Sources API', Component: SourcesApiView },
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
      <div role="tablist" className="flex flex-wrap gap-1 border-b">
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
