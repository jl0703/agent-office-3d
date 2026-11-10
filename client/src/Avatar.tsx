import { AVATAR_KEYS } from "../../shared/avatar.ts";
import { BACKGROUND, HAIR_COLOR, LABELS, OUTFIT_COLOR, PART_TITLE, randomAvatar, sameAvatar, SKIN, type Avatar, type AvatarPart } from "./avatar.ts";

const INK = "#1f2430";

function Hair({ style, color, front }: { style: number; color: string; front: boolean }) {
  const short = <path d="M31 46 C30 24 70 24 69 46 C66 37 58 33 50 33 C42 33 34 37 31 46Z" fill={color} />;
  if (!front) return style === 1 ? <path d="M30 48 C28 20 72 20 70 48 L75 82 L25 82Z" fill={color} /> : null;
  switch (style) {
    case 0:
    case 1:
      return short;
    case 2:
      return (
        <>
          {short}
          <circle cx="50" cy="22" r="8" fill={color} />
        </>
      );
    case 3:
      return (
        <g fill={color}>
          <circle cx="36" cy="33" r="8" />
          <circle cx="50" cy="27" r="9" />
          <circle cx="64" cy="33" r="8" />
          <circle cx="31" cy="43" r="6" />
          <circle cx="69" cy="43" r="6" />
        </g>
      );
    case 4:
      return <path d="M31 44 L33 26 L41 34 L46 22 L52 33 L60 23 L63 35 L69 28 L69 44 C64 37 36 37 31 44Z" fill={color} />;
    case 6:
      return <path d="M31 47 C28 22 66 20 70 42 C64 38 54 34 44 34 C38 34 33 38 31 47Z" fill={color} />;
    case 7:
      return (
        <>
          {short}
          <path d="M66 36 C82 34 84 56 74 66 C76 54 72 46 66 42Z" fill={color} />
        </>
      );
    default:
      return null;
  }
}

function Outfit({ style, color, skin }: { style: number; color: string; skin: string }) {
  const base = <path d="M14 100 C14 78 32 70 50 70 C68 70 86 78 86 100Z" fill={color} />;
  switch (style) {
    case 1:
      return (
        <>
          {base}
          <path d="M42 70 L50 82 L58 70 L62 74 L50 90 L38 74Z" fill="#ffffff" />
          <path d="M44 70 L50 80 L56 70Z" fill={skin} />
        </>
      );
    case 2:
      return (
        <>
          {base}
          <path d="M34 74 Q50 62 66 74 Q50 84 34 74Z" fill="#000000" fillOpacity="0.25" />
          <path d="M45 80 V92 M55 80 V92" stroke="#ffffff" strokeWidth="1.6" strokeLinecap="round" />
        </>
      );
    case 3:
      return (
        <>
          {base}
          <path d="M44 70 L50 90 L56 70Z" fill="#ffffff" />
          <path d="M38 72 L48 92 L40 100 L26 100Z M62 72 L52 92 L60 100 L74 100Z" fill="#000000" fillOpacity="0.22" />
          <path d="M49 78 L51 78 L52 92 L50 96 L48 92Z" fill="#b3392b" />
        </>
      );
    case 4:
      return (
        <>
          {base}
          <rect x="42" y="62" width="16" height="14" rx="4" fill={color} />
          <rect x="42" y="68" width="16" height="3" fill="#000000" fillOpacity="0.2" />
        </>
      );
    default:
      return (
        <>
          {base}
          <path d="M41 70 Q50 80 59 70Z" fill={skin} />
        </>
      );
  }
}

function Eyes({ style }: { style: number }) {
  const line = { stroke: INK, strokeWidth: 2, strokeLinecap: "round" as const, fill: "none" };
  switch (style) {
    case 1:
      return <path d="M39 48 Q42 43 45 48 M55 48 Q58 43 61 48" {...line} />;
    case 2:
      return <path d="M39.5 47 H44.5 M55.5 47 H60.5" {...line} />;
    case 3:
      return (
        <g>
          <circle cx="42" cy="47" r="3.6" fill="#ffffff" stroke={INK} strokeWidth="1" />
          <circle cx="58" cy="47" r="3.6" fill="#ffffff" stroke={INK} strokeWidth="1" />
          <circle cx="42" cy="47" r="1.8" fill={INK} />
          <circle cx="58" cy="47" r="1.8" fill={INK} />
        </g>
      );
    default:
      return (
        <g fill={INK}>
          <circle cx="42" cy="47" r="2.3" />
          <circle cx="58" cy="47" r="2.3" />
        </g>
      );
  }
}

function Mouth({ style }: { style: number }) {
  const line = { stroke: INK, strokeWidth: 2, strokeLinecap: "round" as const, fill: "none" };
  switch (style) {
    case 1:
      return <path d="M43 55 Q50 66 57 55Z" fill="#ffffff" stroke={INK} strokeWidth="1.5" strokeLinejoin="round" />;
    case 2:
      return <path d="M45 58 H55" {...line} />;
    case 3:
      return <ellipse cx="50" cy="58" rx="4" ry="3" fill="#5a1f1f" />;
    default:
      return <path d="M44 56 Q50 62 56 56" {...line} />;
  }
}

function Glasses({ style }: { style: number }) {
  const frame = { stroke: INK, strokeWidth: 1.6, fill: "none" };
  switch (style) {
    case 1:
      return (
        <g {...frame}>
          <circle cx="42" cy="47" r="6.5" />
          <circle cx="58" cy="47" r="6.5" />
          <path d="M48.5 47 H51.5" />
        </g>
      );
    case 2:
      return (
        <g {...frame}>
          <rect x="35.5" y="41.5" width="13" height="11" rx="2" />
          <rect x="51.5" y="41.5" width="13" height="11" rx="2" />
          <path d="M48.5 46 H51.5" />
        </g>
      );
    case 3:
      return (
        <g>
          <rect x="35.5" y="41.5" width="13" height="10" rx="3" fill={INK} />
          <rect x="51.5" y="41.5" width="13" height="10" rx="3" fill={INK} />
          <path d="M48.5 45 H51.5" stroke={INK} strokeWidth="1.6" />
        </g>
      );
    default:
      return null;
  }
}

/** A person's picture, drawn from the numbers of their look. Decorative: the person's name is always next to it. */
export function AvatarImage({ avatar, size = 64 }: { avatar: Avatar; size?: number }) {
  const skin = SKIN[avatar.skin] ?? SKIN[0]!;
  const hair = HAIR_COLOR[avatar.hairColor] ?? HAIR_COLOR[0]!;
  const outfit = OUTFIT_COLOR[avatar.outfitColor] ?? OUTFIT_COLOR[0]!;
  return (
    <svg className="avatar" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <rect width="100" height="100" rx="14" fill={BACKGROUND[avatar.background] ?? BACKGROUND[0]!} />
      <Hair style={avatar.hair} color={hair} front={false} />
      <Outfit style={avatar.outfit} color={outfit} skin={skin} />
      <rect x="44" y="60" width="12" height="14" fill={skin} />
      <circle cx="32" cy="48" r="4" fill={skin} />
      <circle cx="68" cy="48" r="4" fill={skin} />
      <ellipse cx="50" cy="47" rx="18" ry="20" fill={skin} />
      <Hair style={avatar.hair} color={hair} front />
      <Eyes style={avatar.eyes} />
      <Mouth style={avatar.mouth} />
      <Glasses style={avatar.glasses} />
    </svg>
  );
}

const COLOR_PARTS: Partial<Record<AvatarPart, string[]>> = { skin: SKIN, hairColor: HAIR_COLOR, outfitColor: OUTFIT_COLOR, background: BACKGROUND };

/** The designer: a big preview, one row of choices per part, a Randomize button and a Reset to the look the pop-up opened with. */
export function AvatarDesigner({ value, original, onChange }: { value: Avatar; original: Avatar; onChange: (next: Avatar) => void }) {
  return (
    <fieldset className="designer">
      <legend>Picture</legend>
      <div className="designer-top">
        <AvatarImage avatar={value} size={112} />
        <div className="designer-actions">
          <button type="button" onClick={() => onChange(randomAvatar())}>
            Randomize
          </button>
          <button type="button" disabled={sameAvatar(value, original)} onClick={() => onChange(original)}>
            Reset
          </button>
        </div>
      </div>
      {AVATAR_KEYS.map((k) => (
        <div key={k} className="designer-row" role="group" aria-label={PART_TITLE[k]}>
          <span className="designer-label" aria-hidden="true">
            {PART_TITLE[k]}
          </span>
          <div className="designer-options">
            {LABELS[k].map((label, i) => {
              const colors = COLOR_PARTS[k];
              return colors ? (
                <button key={label} type="button" className="swatch" style={{ background: colors[i] }} aria-label={label} aria-pressed={value[k] === i} onClick={() => onChange({ ...value, [k]: i })} />
              ) : (
                <button key={label} type="button" className="chip-filter" aria-pressed={value[k] === i} onClick={() => onChange({ ...value, [k]: i })}>
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </fieldset>
  );
}
