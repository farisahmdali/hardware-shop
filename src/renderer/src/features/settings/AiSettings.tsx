import { useEffect, useState } from 'react';
import { CircleCheck, KeyRound, TriangleAlert } from 'lucide-react';
import type { AllSettings } from '@shared/settings';
import type { AiTestResult } from '@shared/contracts';
import { call, errorMessage, useCommandMutation, useCommandQuery } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/button';
import { Field, Input, Switch } from '../../components/ui/form';
import { Card, CardHeader, ErrorBanner, Spinner } from '../../components/ui/layout';

/** Examples only: any OpenRouter model that reads images works; Test connection checks it. */
const MODEL_EXAMPLES = ['google/gemini-2.5-flash', 'openai/gpt-4.1-mini', 'anthropic/claude-sonnet-4.5'];

/** The optional AI assistant: reads supplier bills through OpenRouter with the owner's own key. */
export function AiSettings() {
  const settings = useCommandQuery('settings.get');
  const status = useCommandQuery('ai.status');
  const save = useCommandMutation('settings.update', { invalidate: ['settings.', 'ai.'] });
  const setKey = useCommandMutation('ai.setKey', { invalidate: ['ai.'] });
  const clearKey = useCommandMutation('ai.clearKey', { invalidate: ['ai.'] });
  const toast = useToast();
  const [r, setR] = useState<AllSettings['ai'] | null>(null);
  const [key, setKeyText] = useState('');
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: AiTestResult } | { error: string } | null>(null);
  useEffect(() => {
    if (settings.data) setR(settings.data.ai);
  }, [settings.data]);
  if (!r || !status.data) return <Spinner />;
  const st = status.data;
  const set = <K extends keyof AllSettings['ai']>(k: K, v: AllSettings['ai'][K]) => setR({ ...r, [k]: v });

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest({ ok: await call('ai.test', { model: r.model }) });
    } catch (e) {
      setTest({ error: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader
          title="AI assistant"
          description="Reads a photo or PDF of a supplier's bill and fills in the purchase for you to check. Uses your own OpenRouter account."
        />
        <div className="flex max-w-3xl flex-col gap-5 p-5">
          <div className="rounded-md border border-line bg-surface-2 px-4 py-3 text-[13px] text-ink-2">
            <p className="font-medium text-ink">What is sent, and where</p>
            <p className="mt-1">
              Only the bill file you choose is sent, to OpenRouter (openrouter.ai) and the AI company running the model you pick. Nothing else
              leaves this computer: not your products, customers, sales or accounts. Everything else in the app keeps working without the
              internet. The AI never saves anything: you check the filled-in bill and save it yourself.
            </p>
          </div>
          <Switch
            checked={r.enabled}
            onChange={(v) => set('enabled', v)}
            label="Scan supplier bills with AI"
            description="Shows a “Scan supplier's bill” button on New purchase. Needs the internet while a bill is being read."
          />
          <Field
            label="AI model"
            hint={
              <>
                The OpenRouter model id, as shown on openrouter.ai/models. It must read images. For example: {MODEL_EXAMPLES.join(', ')}.
              </>
            }
          >
            {(p) => (
              <>
                <Input {...p} list="ai-model-examples" value={r.model} onChange={(e) => set('model', e.target.value.trim())} maxLength={120} placeholder="provider/model-name" />
                <datalist id="ai-model-examples">
                  {MODEL_EXAMPLES.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
          <Field label="Bill scans allowed per month" hint={`Protects against unexpected charges. Used this month: ${st.scansThisMonth}.`}>
            {(p) => (
              <Input
                {...p}
                type="number"
                min={1}
                max={10000}
                className="max-w-40"
                value={r.monthlyScanLimit}
                onChange={(e) => set('monthlyScanLimit', Math.max(1, Math.min(10_000, Math.trunc(Number(e.target.value) || 1))))}
              />
            )}
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              busy={save.isPending}
              onClick={async () => {
                try {
                  await save.mutateAsync({ section: 'ai', value: r });
                  toast.success('AI assistant settings saved');
                } catch (e) {
                  toast.error('Not saved', errorMessage(e));
                }
              }}
            >
              Save AI settings
            </Button>
            <Button variant="outline" busy={testing} disabled={!st.hasKey || !r.model} onClick={runTest}>
              Test connection
            </Button>
          </div>
          {test && 'error' in test && <ErrorBanner title="Connection test failed" message={test.error} />}
          {test && 'ok' in test && <TestResult result={test.ok} />}
        </div>
      </Card>

      <Card>
        <CardHeader title="OpenRouter API key" description="Create a key at openrouter.ai → Keys. You pay OpenRouter for what you use; a bill usually costs well under a rupee." />
        <div className="flex max-w-3xl flex-col gap-4 p-5">
          <p className="flex items-center gap-2 text-ink-2">
            <KeyRound className="size-4" />
            {st.hasKey ? (
              <span>
                A key is saved{st.keyEnding ? `, ending …${st.keyEnding}` : ''}. It is kept encrypted on this computer, for this Windows user, and is not part of backups.
              </span>
            ) : (
              <span>No key saved.</span>
            )}
          </p>
          {!st.canStoreKey && <ErrorBanner title="The key cannot be saved" message="Windows cannot keep the key encrypted for this user." />}
          <div className="flex flex-wrap items-end gap-2">
            <Field label={st.hasKey ? 'Replace with a new key' : 'API key'} className="min-w-80 flex-1">
              {(p) => <Input {...p} type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKeyText(e.target.value)} placeholder="sk-or-v1-…" />}
            </Field>
            <Button
              disabled={key.trim().length < 20 || !st.canStoreKey}
              busy={setKey.isPending}
              onClick={async () => {
                try {
                  await setKey.mutateAsync({ key: key.trim() });
                  setKeyText('');
                  setTest(null);
                  toast.success('API key saved');
                } catch (e) {
                  toast.error('Key not saved', errorMessage(e));
                }
              }}
            >
              Save key
            </Button>
            {st.hasKey && (
              <Button
                variant="outline"
                busy={clearKey.isPending}
                onClick={async () => {
                  try {
                    await clearKey.mutateAsync({});
                    setTest(null);
                    toast.success('API key removed');
                  } catch (e) {
                    toast.error('Not removed', errorMessage(e));
                  }
                }}
              >
                Remove key
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

function TestResult({ result }: { result: AiTestResult }) {
  const good = result.readsImages;
  return (
    <div className={`rounded-md border px-4 py-3 text-[13px] ${good ? 'border-success/30 bg-success-soft' : 'border-warning/30 bg-warning-soft'}`} role="status">
      <p className="flex items-center gap-2 font-medium text-ink">
        {good ? <CircleCheck className="size-4 text-success" /> : <TriangleAlert className="size-4 text-warning" />}
        {good ? `Connected. ${result.modelName} can read bills.` : `Connected, but ${result.modelName} cannot read images. Choose another model.`}
      </p>
      <ul className="mt-1.5 list-disc pl-6 text-ink-2">
        <li>{result.readsPdf ? 'Reads PDF bills itself.' : 'PDF bills are converted to text by OpenRouter first (photos work best).'}</li>
        <li>{result.structuredOutput ? 'Answers in a fixed format (most reliable).' : 'Does not support a fixed answer format; answers are checked carefully.'}</li>
        {result.creditLeft !== null && <li>Credit left on this key: US$ {result.creditLeft.toFixed(2)}</li>}
      </ul>
    </div>
  );
}
