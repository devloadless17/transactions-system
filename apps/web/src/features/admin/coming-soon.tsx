import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function ComingSoon({ title, phase }: { title: string; phase: string }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Coming in {phase}</CardTitle>
          <CardDescription>This module is on the roadmap.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          See <code className="font-mono text-xs">apps/api</code> module structure for the planned
          shape.
        </CardContent>
      </Card>
    </div>
  );
}
