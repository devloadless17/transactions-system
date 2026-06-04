'use client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function KpiCard({
  label,
  value,
  hint,
  align = 'left',
}: {
  label: string;
  value: string;
  hint?: string;
  align?: 'left' | 'right';
}) {
  const alignClass = align === 'right' ? 'text-right' : '';
  return (
    <Card>
      <CardHeader className={`space-y-1 pb-2 ${alignClass}`}>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="font-mono text-2xl">{value}</CardTitle>
      </CardHeader>
      {hint && (
        <CardContent className={`pt-0 text-xs text-muted-foreground ${alignClass}`}>
          {hint}
        </CardContent>
      )}
    </Card>
  );
}
