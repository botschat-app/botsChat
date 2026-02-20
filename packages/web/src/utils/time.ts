const timeOnly: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
const dateShort: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
const full: Intl.DateTimeFormatOptions = {
  year: "numeric", month: "short", day: "numeric",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
};

function isToday(d: Date): boolean {
  const now = new Date();
  return d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
}

export function formatMessageTime(ts: number): string {
  const d = new Date(ts);
  if (isToday(d)) return d.toLocaleTimeString([], timeOnly);
  return `${d.toLocaleDateString([], dateShort)} ${d.toLocaleTimeString([], timeOnly)}`;
}

export function formatFullDateTime(ts: number): string {
  return new Date(ts).toLocaleString([], full);
}
