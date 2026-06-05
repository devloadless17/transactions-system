import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

// Plain how-to for the Whish Pay feature (the working tool lives under the
// "Whish Pay" sidebar item). Kept deliberately simple.
export function WhishDocsView() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Whish Pay</h1>
        <p className="text-sm text-muted-foreground">
          Generate a payment link, share it with your customer, and the money settles into your
          wallet automatically once they pay — no card details ever touch your system.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>1. Create a payment link</CardTitle>
          <CardDescription>
            Open Whish Pay from the sidebar and click New payment link.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          <ul className="ml-4 list-disc space-y-1 text-muted-foreground">
            <li>
              Enter the <strong>amount</strong> and the <strong>currency</strong> (USD).
            </li>
            <li>
              Add an <strong>invoice / description</strong> (e.g.{' '}
              <code className="font-mono">Order #1234</code>) so you can recognise the payment
              later.
            </li>
            <li>
              Click <strong>Generate link</strong> — you get a Whish-hosted payment link right away.
            </li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Share it with your customer</CardTitle>
          <CardDescription>Copy or open the link and send it however you like.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Your customer pays on Whish&apos;s own secure page. You never handle their card or wallet
          details — you only share the link.
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3. Money settles automatically</CardTitle>
          <CardDescription>Once the customer pays, it lands in your wallet.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            When the payment is confirmed, the amount is credited to your wallet (net of the
            platform commission) and a transaction is created for you automatically.
          </p>
          <div className="rounded-md border bg-muted/30 p-3">
            <p className="mb-1 font-medium text-foreground">Statuses you&apos;ll see</p>
            <ul className="ml-4 list-disc space-y-0.5">
              <li>
                <strong>PENDING</strong> — link created, waiting for the customer to pay.
              </li>
              <li>
                <strong>PAID</strong> — paid and settled into your wallet.
              </li>
              <li>
                <strong>FAILED / EXPIRED</strong> — the payment didn&apos;t complete (e.g. the link
                went unpaid).
              </li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>4. Track your links</CardTitle>
          <CardDescription>The Whish Pay page lists every link and its status.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Each row shows the reference, invoice, amount, status, the shareable link, and — once paid
          — the settled transaction. If a paid link still shows <strong>PENDING</strong> (a
          confirmation was delayed), click <strong>Refresh</strong> to pull the latest status; it
          also catches up on its own within about a minute.
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Good to know</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <ul className="ml-4 list-disc space-y-1 text-muted-foreground">
            <li>Payments are in USD.</li>
            <li>
              A commission is deducted when the payment settles — the transaction&apos;s net amount
              is exactly what reaches your wallet.
            </li>
            <li>Unpaid links expire after a while; just generate a new one.</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
