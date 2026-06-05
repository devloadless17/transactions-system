import { redirect } from 'next/navigation';

// CRM moved into the unified Documentation hub.
export default function CrmPage() {
  redirect('/app/documentation?tab=crm');
}
