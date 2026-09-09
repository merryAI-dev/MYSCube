import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from './button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './command';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { cn } from './utils';
import type { OrgMemberPickerOption } from '../../data/project-team-member-options';

/**
 * Person picker with a search box. The org has ~90 members, which is more than anyone
 * wants to scroll through, and the same list is chosen from in several places.
 */
export function MemberPicker({
  options,
  value,
  onChange,
  placeholder = '구성원을 선택하세요',
  emptyLabel = '구성원 원장을 불러오는 중입니다',
  disabled = false,
  className,
}: {
  options: OrgMemberPickerOption[];
  value: string;
  onChange: (uid: string) => void;
  placeholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(
    () => options.find((option) => option.uid === value) || null,
    [options, value],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled || options.length === 0}
          className={cn('w-full justify-between font-normal', className)}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {options.length === 0 ? emptyLabel : selected?.label || placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command
          filter={(itemValue, search) => {
            const option = options.find((entry) => entry.uid === itemValue);
            if (!option) return 0;
            return option.searchText.includes(search.trim().toLowerCase()) ? 1 : 0;
          }}
        >
          <CommandInput placeholder="이름 · 별명 · 이메일로 검색" />
          <CommandList>
            <CommandEmpty>검색 결과가 없습니다.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.uid}
                  value={option.uid}
                  onSelect={() => {
                    onChange(option.uid);
                    setOpen(false);
                  }}
                  className="gap-2"
                >
                  <Check className={cn('h-4 w-4', option.uid === value ? 'opacity-100' : 'opacity-0')} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{option.label}</span>
                    {option.email ? (
                      <span className="truncate text-[11px] text-muted-foreground">{option.email}</span>
                    ) : null}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
