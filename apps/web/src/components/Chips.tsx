/** Filter chip row. Items are [key, label, count?]. */
export function Chips({
  id,
  items,
  current,
  onPick,
}: {
  id: string;
  items: [string, string, number?][];
  current: string;
  onPick: (k: string) => void;
}) {
  return (
    <div className="chips" id={id}>
      {items.map(([k, l, c]) => (
        <button className="chip" key={k} aria-pressed={k === current} onClick={() => onPick(k)}>
          {l}
          {c != null && <span className="c">{c}</span>}
        </button>
      ))}
    </div>
  );
}
