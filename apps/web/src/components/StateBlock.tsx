import { Card, CardContent } from './ui/card';

export function LoadingBlock({ label }: { label: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-8 text-sm text-muted-foreground">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
        {label}
      </CardContent>
    </Card>
  );
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Card className="border-destructive/40">
      <CardContent className="space-y-3 py-6">
        <p className="text-sm text-destructive">{message}</p>
        {onRetry ? (
          <button type="button" className="text-xs uppercase tracking-wider text-primary" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function EmptyBlock({ title, body }: { title: string; body: string }) {
  return (
    <Card>
      <CardContent className="space-y-2 py-8">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
      </CardContent>
    </Card>
  );
}
