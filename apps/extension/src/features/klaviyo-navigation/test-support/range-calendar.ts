/**
 * Test double of a combined date-range control as seen live (run dfedae86): one bordered control showing
 * "Sep 01, 2026 — Sep 30, 2026" through two text inputs ("Start Date" / "End Date") whose values are owned by the
 * component. Programmatic value writes and text insertion are re-rendered back (they left Klaviyo on September);
 * only picking days in its calendar popover changes the range. The popover shows two months with previous/next-month
 * buttons; start is picked first, then focus moves to the end date, as a person sees it.
 */
export interface RangeCalendarOptions {
  /** Cells for the neighbouring months' days: labelled with their real date, number-only, or absent. */
  outsideDays?: "labelled" | "number-only" | "none";
  /** Day cells identified only by their number inside their month grid (no accessible date). */
  numberOnlyDays?: boolean;
  monthsShown?: number;
  /** Month heading painted in pieces: <strong><span>April</span> <span>2026</span></strong>. */
  splitCaption?: boolean;
  /** Called whenever the range changes (start, end ISO or null). */
  onChange?: (start: string | null, end: string | null) => void;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (value: number) => String(value).padStart(2, "0");
export const fieldFormat = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]!.slice(0, 3)} ${iso.slice(8, 10)}, ${iso.slice(0, 4)}`;
const isoOf = (year: number, monthIndex: number, day: number) => { const date = new Date(Date.UTC(year, monthIndex, day)); return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`; };
const longLabel = (iso: string) => new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));

export function installRangeCalendar(start: HTMLInputElement, end: HTMLInputElement, initial: { startDate: string; endDate: string }, options: RangeCalendarOptions = {}) {
  const state = { start: initial.startDate as string | null, end: initial.endDate as string | null, focus: "start" as "start" | "end", firstMonth: Number(initial.startDate.slice(0, 4)) * 12 + Number(initial.startDate.slice(5, 7)) - 1 };
  const clicked: string[] = []; let navigations = 0;
  const setNative = (input: HTMLInputElement, value: string) => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  const render = () => { setNative(start, state.start ? fieldFormat(state.start) : ""); setNative(end, state.end ? fieldFormat(state.end) : ""); };
  // The component owns the values: anything not done through its calendar is rendered back.
  for (const input of [start, end]) input.addEventListener("input", () => render(), true);
  let popover: HTMLElement | null = null;
  const close = () => { popover?.remove(); popover = null; };
  const draw = () => {
    popover ??= Object.assign(document.createElement("div"), { className: "DayPicker" });
    popover.setAttribute("data-popper-placement", "bottom-start");
    const months = Array.from({ length: options.monthsShown ?? 2 }, (_, offset) => state.firstMonth + offset).map((index) => {
      const year = Math.floor(index / 12); const month = index % 12;
      const leading = new Date(Date.UTC(year, month, 1)).getUTCDay(); const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      const cell = (iso: string, outside: boolean) => {
        const day = String(Number(iso.slice(8, 10)));
        if (outside && options.outsideDays === "none") return "<td></td>";
        const label = outside ? (options.outsideDays === "labelled" ? ` aria-label="${longLabel(iso)}"` : "") : options.numberOnlyDays ? "" : ` aria-label="Choose ${longLabel(iso)} as your ${state.focus} date."`;
        return `<td role="button" class="CalendarDay${outside ? " CalendarDay__outside" : ""}" data-iso="${iso}"${label}>${day}</td>`;
      };
      const cells = [...Array.from({ length: leading }, (_, i) => cell(isoOf(year, month, i - leading + 1), true)), ...Array.from({ length: days }, (_, i) => cell(isoOf(year, month, i + 1), false))];
      let trailing = 1; while (cells.length % 7) cells.push(cell(isoOf(year, month + 1, trailing++), true));
      const rows = Array.from({ length: cells.length / 7 }, (_, row) => `<tr>${cells.slice(row * 7, row * 7 + 7).join("")}</tr>`).join("");
      return `<div class="CalendarMonth"><div class="CalendarMonth_caption"><strong>${options.splitCaption ? `<span>${MONTHS[month]}</span> <span>${year}</span>` : `${MONTHS[month]} ${year}`}</strong></div><table role="presentation"><tbody>${rows}</tbody></table></div>`;
    }).join("");
    popover.innerHTML = `<div class="DayPickerNavigation"><button type="button" aria-label="Move backward to switch to the previous month.">‹</button><button type="button" aria-label="Move forward to switch to the next month.">›</button></div>${months}`;
    const [previous, next] = Array.from(popover.querySelectorAll<HTMLButtonElement>(".DayPickerNavigation button"));
    previous!.addEventListener("click", () => { state.firstMonth -= 1; navigations += 1; draw(); });
    next!.addEventListener("click", () => { state.firstMonth += 1; navigations += 1; draw(); });
    for (const day of Array.from(popover.querySelectorAll<HTMLElement>("td[data-iso]"))) day.addEventListener("click", () => {
      const iso = day.dataset.iso!; clicked.push(`${state.focus}:${iso}${day.classList.contains("CalendarDay__outside") ? ":outside" : ""}`);
      if (state.focus === "start") { state.start = iso; if (state.end && iso > state.end) state.end = null; state.focus = "end"; }
      else if (state.start && iso < state.start) state.start = iso;
      else { state.end = iso; state.focus = "start"; render(); options.onChange?.(state.start, state.end); close(); return; }
      render(); options.onChange?.(state.start, state.end); draw();
    });
    if (!popover.isConnected) document.body.append(popover);
  };
  const openFrom = (focus: "start" | "end") => () => { state.focus = focus; if (!popover) { const shown = focus === "end" && state.end ? state.end : state.start ?? initial.startDate; state.firstMonth = Number(shown.slice(0, 4)) * 12 + Number(shown.slice(5, 7)) - 1; } draw(); };
  start.addEventListener("click", openFrom("start")); end.addEventListener("click", openFrom("end"));
  render();
  return { range: () => [state.start, state.end] as const, clicked: () => clicked, navigations: () => navigations, open: () => Boolean(popover), close };
}
