'use client';
import { useEffect, useState } from 'react';
import { toast } from '@/lib/toast';
import type { CommissionRuleGroupResponse, CompanyResponse } from '@app/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';
import { CompanyMultiSelect } from './company-multi-select';
import {
  CommissionRuleFields,
  buildRuleSpec,
  defaultRuleDraft,
  draftFromGroup,
  type RuleDraft,
} from './rule-fields';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companies: CompanyResponse[];
  group?: CommissionRuleGroupResponse | null;
  onSaved: () => void;
}

export function CommissionRuleDialog({ open, onOpenChange, companies, group, onSaved }: Props) {
  const editing = !!group;
  const [name, setName] = useState('');
  const [companyIds, setCompanyIds] = useState<string[]>([]);
  const [draft, setDraft] = useState<RuleDraft>(defaultRuleDraft);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (group) {
      setName(group.name ?? '');
      setCompanyIds(group.companyIds ?? []);
      setDraft(draftFromGroup(group));
    } else {
      setName('');
      setCompanyIds([]);
      setDraft(defaultRuleDraft());
    }
  }, [open, group]);

  async function submit() {
    const built = buildRuleSpec(draft, {
      name: name.trim() || null,
      active: group?.active ?? true,
    });
    if (!built.ok) {
      toast.error(built.error);
      return;
    }
    const body = { ...built.value, companyIds: companyIds.length ? companyIds : null };

    setSubmitting(true);
    try {
      if (editing) {
        await apiFetch(`/admin/commission-rules/${group.groupId}`, { method: 'PATCH', body });
        toast.success('Rule updated');
      } else {
        await apiFetch('/admin/commission-rules', { method: 'POST', body });
        toast.success('Rule created');
      }
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Failed to save');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit commission rule' : 'New commission rule'}</DialogTitle>
          <DialogDescription>
            Apply the same fee tiers to a set of companies and operations.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="rule-name">
              Name <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="rule-name"
              placeholder="e.g. Standard fees, VIP partners…"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              A label so you can recognise this rule later.
            </p>
          </div>

          {/* Companies */}
          <div className="space-y-2">
            <Label>Companies</Label>
            <CompanyMultiSelect companies={companies} value={companyIds} onChange={setCompanyIds} />
            <p className="text-xs text-muted-foreground">
              Leave empty to apply to <span className="font-medium">all companies</span>.
            </p>
          </div>

          {/* Shared editor: operations, tiers, priority */}
          <CommissionRuleFields draft={draft} onChange={setDraft} />
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={submitting} onClick={submit}>
            {submitting ? 'Saving…' : editing ? 'Save changes' : 'Create rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
