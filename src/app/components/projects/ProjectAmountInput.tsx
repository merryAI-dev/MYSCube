import { useId, type ComponentProps } from 'react';
import { Input } from '../ui/input';
import { parseProjectAmountEntry } from '../../platform/project-contract-amount';

type Props = Omit<ComponentProps<typeof Input>, 'onChange'> & {
  issueLabel: string;
  rawValue?: string;
  onRawChange: (value: string | undefined) => void;
  onValueChange: (value: string) => void;
};

export function ProjectAmountInput({ issueLabel, rawValue, onRawChange, onValueChange, value, ...props }: Props) {
  const errorId = useId();
  const invalid = rawValue !== undefined && parseProjectAmountEntry(rawValue) === null;
  return (
    <div data-issue-label={issueLabel}>
      <Input
        {...props}
        inputMode="numeric"
        value={rawValue ?? value}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : props['aria-describedby']}
        onChange={(event) => {
          const raw = event.target.value;
          onRawChange(raw);
          const amount = parseProjectAmountEntry(raw);
          if (amount !== null) onValueChange(raw.trim() ? String(amount) : '');
        }}
        onBlur={() => {
          if (!invalid) onRawChange(undefined);
        }}
      />
      {invalid && <p id={errorId} role="alert" className="mt-1 text-xs text-red-600">0 이상의 정수 금액을 입력해 주세요. 기존 금액은 유지됩니다.</p>}
    </div>
  );
}
