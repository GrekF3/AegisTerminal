"use client";

import { useEffect, useId, useRef, useState } from 'react';
import { CaretDown, Check, CircleNotch, MagnifyingGlass } from '@phosphor-icons/react';
import { Button } from './button';
import { Input } from './input';

export type BrowserProfile = { id: string; name: string; status: string };
export function ProfilePicker({ profiles, value, savedName, loading, onRefresh, onSelect }: {
  profiles: BrowserProfile[]; value: string; savedName?: string; loading: boolean;
  onRefresh: () => Promise<void>; onSelect: (profile: BrowserProfile) => void;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), search = useRef<HTMLInputElement>(null);
  const id = useId();
  const selected = profiles.find(p => p.id === value);
  const filtered = profiles.filter(p => `${p.name} ${p.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    // Radix Dialog handles Escape during document capture. Consume it one level
    // earlier so the first Escape closes this list, not the entire credentials form.
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && root.current?.contains(event.target as Node)) {
        event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape, true); };
  }, [open]);
  useEffect(() => { setActive(0); }, [query, profiles]);
  useEffect(() => { if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({block:'nearest'}); }, [active, open, id]);
  function choose(profile: BrowserProfile) { onSelect(profile); setOpen(false); setQuery(''); trigger.current?.focus(); }
  return <div className="profile-picker" ref={root} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.stopPropagation(); event.preventDefault(); setOpen(false); trigger.current?.focus(); }
  }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
    <div className="undetectable-profile-row">
      <button ref={trigger} className="input profile-picker-trigger" type="button" aria-label="Профиль Undetectable" aria-haspopup="listbox" aria-expanded={open} aria-controls={id} onClick={() => { setQuery(''); setOpen(v => !v); }} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); }
      }}><span>{selected?.name || savedName || (value ? 'Сохранённый профиль' : 'Выберите профиль')}</span><CaretDown size={16} /></button>
      <Button variant="outline" disabled={loading} onClick={async () => { await onRefresh(); setQuery(''); setOpen(true); }}>
        {loading ? <CircleNotch size={16} className="spin" /> : <MagnifyingGlass size={16} />}Найти профили
      </Button>
    </div>
    {open && <div className="profile-picker-menu">
      <div className="profile-picker-search"><MagnifyingGlass size={17} /><Input ref={search} role="combobox" aria-label="Поиск профилей" aria-expanded="true" aria-autocomplete="list" aria-controls={id} aria-activedescendant={filtered[active] ? `${id}-${active}` : undefined} placeholder="Поиск по имени или ID" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, Math.min(filtered.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))); }
        if (event.key === 'Enter') { event.preventDefault(); if (filtered[active]) choose(filtered[active]); }
      }} /></div>
      <div id={id} className="profile-picker-options" role="listbox" aria-label="Профили Undetectable">
        {filtered.map((profile,index) => <button id={`${id}-${index}`} key={profile.id} type="button" role="option" aria-selected={profile.id === value} className={index === active ? 'highlighted' : ''} tabIndex={-1} onMouseEnter={() => setActive(index)} onMouseDown={e => e.preventDefault()} onClick={() => choose(profile)}>
          <span className="profile-picker-name"><strong>{profile.name}</strong><small>{profile.status === 'Started' ? 'Запущен' : 'Не запущен'}</small></span>{profile.id === value && <Check size={16} />}
        </button>)}
        {!filtered.length && <div className="profile-picker-empty" role="status">{loading ? 'Ищем профили…' : query ? 'Ничего не найдено' : 'Нажмите «Найти профили»'}</div>}
      </div>
    </div>}
  </div>;
}
