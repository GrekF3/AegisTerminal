import type { UpdateStatus } from '@/types/desktop';

function bytes(value: number) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const unit = value > 0 ? Math.min(3, Math.floor(Math.log(value) / Math.log(1024))) : 0;
  return `${new Intl.NumberFormat('ru', { maximumFractionDigits: unit ? 1 : 0 }).format(value / 1024 ** unit)} ${units[unit]}`;
}

export function updateLabel(status: UpdateStatus) {
  if (status.state === 'downloading') {
    if (status.phase === 'preparing') return 'Сравниваем файлы';
    if (status.phase === 'verifying') return 'Проверяем пакет';
    return status.downloadMode === 'differential' ? 'Загружаем изменения' : 'Загружаем обновление';
  }
  return ({ idle: 'Не проверялись', checking: 'Проверяем обновления', available: 'Доступно обновление', current: 'Версия актуальна', ready: 'Обновление готово', restarting: 'Перезапускаем', error: 'Ошибка обновления', development: 'Локальная сборка', 'not-configured': 'Не настроены' } as Record<string, string>)[status.state] || status.state;
}

export function UpdateProgressDetails({ status }: { status: UpdateStatus }) {
  if (!['available', 'downloading', 'ready', 'error'].includes(status.state)) return null;
  const files = status.files?.length ? status.files : status.fileName ? [status.fileName] : [];
  const hasBytes = typeof status.transferred === 'number' && typeof status.total === 'number';
  return <div className="update-file-details">
    {files.length > 0 && <ul aria-label={status.phase === 'preparing' ? 'Сравниваемые файлы' : 'Файл обновления'}>{files.map(file => <li key={file}>{file}</li>)}</ul>}
    {hasBytes && <p className="update-transfer">{bytes(status.transferred!)} / {bytes(status.total!)}{status.bytesPerSecond ? ` · ${bytes(status.bytesPerSecond)}/с` : ''}</p>}
    {status.reusedBytes != null && status.reusedBytes > 0 && <p>Из сохранённой копии: {bytes(status.reusedBytes)}</p>}
    {status.downloadMode === 'cached' && <p>Используем уже загруженный пакет</p>}
    {status.fallbackReason && <p>{status.fallbackReason}</p>}
  </div>;
}
