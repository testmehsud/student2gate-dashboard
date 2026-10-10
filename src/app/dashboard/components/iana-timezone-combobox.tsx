'use client';

import { KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { filterIanaTimezoneOptions, moveIanaTimezoneActiveIndex, selectIanaTimezoneOption } from '@/lib/school-update';

export default function IanaTimezoneCombobox({
  id,
  name,
  value,
  options,
  disabled,
  required,
  invalid,
  describedBy,
  inputRef,
  onChange,
}: {
  id: string;
  name: string;
  value: string;
  options: readonly string[];
  disabled: boolean;
  required: boolean;
  invalid: boolean;
  describedBy?: string;
  inputRef?: (element: HTMLInputElement | null) => void;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const previousSelection = useRef(value);
  const matches = useMemo(
    () => filterIanaTimezoneOptions(options, query),
    [options, query],
  );
  const listboxId = id + '-options';

  useEffect(() => {
    if (open && matches[activeIndex]) {
      document.getElementById(listboxId + '-' + activeIndex)?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, listboxId, matches, open]);

  function choose(timezone: string) {
    const selected = selectIanaTimezoneOption(options, timezone);
    if (!selected) return;
    onChange(selected);
    previousSelection.current = timezone;
    setQuery('');
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) {
        previousSelection.current = value;
        setQuery('');
        setOpen(true);
        setActiveIndex(0);
      } else {
        setActiveIndex((current) => moveIanaTimezoneActiveIndex(current, 'down', matches.length));
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        previousSelection.current = value;
        setQuery('');
        setOpen(true);
        setActiveIndex(Math.max(matches.length - 1, 0));
      } else {
        setActiveIndex((current) => moveIanaTimezoneActiveIndex(current, 'up', matches.length));
      }
    } else if (event.key === 'Enter' && open) {
      event.preventDefault();
      const selected = matches[activeIndex];
      if (selected) choose(selected);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      onChange(previousSelection.current);
      setQuery('');
      setOpen(false);
    } else if (event.key === 'Tab') {
      setOpen(false);
      setQuery('');
    }
  }

  return (
    <div className="relative">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && matches[activeIndex] ? listboxId + '-' + activeIndex : undefined}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        aria-required={required}
        required={required}
        autoComplete="off"
        disabled={disabled}
        ref={inputRef}
        value={open ? query : value}
        placeholder="Search IANA timezones, for example Asia/Karachi"
        onFocus={() => {
          if (!open) {
            previousSelection.current = value;
            setQuery('');
            setActiveIndex(-1);
            setOpen(true);
          }
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          if (value !== '') onChange('');
          setActiveIndex(0);
          setOpen(true);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          setOpen(false);
          setQuery('');
        }}
        className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
      />
      <input type="hidden" name={name} value={value} />
      {open && !disabled && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="IANA timezone options"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-slate-300 bg-white py-1 shadow-xl"
        >
          {matches.length === 0 ? (
            <li className="px-4 py-3 text-sm text-slate-500">No matching IANA timezones.</li>
          ) : matches.map((timezone, index) => (
            <li
              id={listboxId + '-' + index}
              key={timezone}
              role="option"
              aria-selected={timezone === value}
              onPointerDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(timezone)}
              className={'cursor-pointer px-4 py-2 text-sm ' + (index === activeIndex ? 'bg-slate-100 text-slate-900' : 'text-slate-700')}
            >
              {timezone}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
