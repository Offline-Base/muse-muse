# Source: owner paste, Oct 31, 2026. A Gemini reading of meta.ai screenshots.
# Measurements are estimates, not captured values. Real measurements beat this file.
# Its background claims (the people it names, the mascot, and the typeface's maker and history) are unverified and
# weren't used. Below is the paste as it came, so its punctuation is the source's. docs/BRAND.md says what was used.

i want to make the UI closer to what is on meta.ai 

I have a prompt here with instruction on branding, i also want you to convert it into skill files for the muse muse tool to use in builds themselves: 

<pasted_content id="5d80">
Conversation with Gemini
I need you to write me like a brand md that directly explains how to recreate the ui in the screenshots. This is from meta. find any font stuff you can find online and any design info

Online Typography & Design System Findings
Product & Design Era: The screenshots capture the 2026 Meta AI (meta.ai) web interface built around Muse (including Muse Spark and Muse Image from Meta Superintelligence Labs). Product design for Muse is led by Meta Design Director Alex Cornell, with the plush cream-colored character Jolly serving as the visual mascot (seen in your second screenshot).   
Screenshot 2026-10-31 at 2.19.08 PM.png
+ 2

Brand Mark (The Purple Flower/Pinwheel): Meta replaced its legacy blue-cyan ring with a 7-petal radial purple flower/pinwheel mark representing Muse Spark. Each petal is a tapered teardrop rotated radially with a subtle violet-to-periwinkle gradient (#7C3AED → #9333EA → #818CF8).   
Screenshot 2026-10-31 at 2.19.08 PM.png
+ 2

Proprietary Typography (Optimistic by Dalton Maag):

Across its brand and web touchpoints (meta.ai, ai.meta.com), Meta uses Optimistic Display for headings and Optimistic Text for body copy and UI controls, alongside its internal Facebook Design System (FDS) tokens.

Designed by the London-based foundry Dalton Maag, the typeface is a geometric sans-serif with humanist warmth, featuring a single-story lowercase a, open apertures (c, e, s) for high legibility at small UI sizes (12px–14px), and slightly rounded stroke terminals.   
Screenshot 2026-10-31 at 2.19.08 PM.png

Because Optimistic Display and Optimistic Text are proprietary Meta assets and not on Google Fonts, the closest open-source recreation stack pairs Inter (with open-aperture stylistic alternates enabled) or Plus Jakarta Sans with macOS's native SF Pro Text / Display.

Core UX Principles (Alex Cornell's Muse Architecture):

Borderless Canvas & Conversational Minimalism: Assistant responses sit directly on the #FFFFFF canvas without grey message boxes, while only user messages sit inside soft #F4F4F5 pills/bubbles.   
Screenshot 2026-10-31 at 2.19.23 PM.jpg
+ 1

Progressive Disclosure of Chain-of-Thought: Instead of streaming raw reasoning tokens into the main chat thread, thinking is collapsed behind a compact "Show thinking >" trigger next to the purple pinwheel icon, expanding into a dedicated right-hand Steps / Sources timeline drawer on demand.   
Screenshot 2026-10-31 at 2.19.23 PM.jpg
+ 1

Multimodal Studio Primitives: The left sidebar elevates first-class creative views—Media, Artifacts (side-by-side interactive code/docs), Scheduled (recurring agent tasks), and Vibes (short-form AI-generated video feeds).   
Screenshot 2026-10-31 at 2.19.08 PM.png

Complete BRAND.md Specification
Copy and save the following Markdown file as BRAND.md (or DESIGN_SYSTEM.md) in your repository root for AI coding agents (Cursor, Claude Code, v0) or frontend engineers to recreate the UI 1:1.

Markdown
# Meta AI (Muse Web UI) — Brand & UI Recreation Guide (`BRAND.md`)

## 1. Visual Philosophy & Core Principles
The Meta AI (Muse) web interface is an ultra-clean, high-key **daylight-first workspace** defined by:
1. **Zero-Chrome Canvas**: The entire viewport is pure white (`#FFFFFF`). There is **no vertical divider line** separating the left navigation sidebar from the center canvas; spatial separation is achieved strictly through whitespace and alignment.
2. **Soft Elevation Over Hard Borders**: Interactive surfaces (the prompt composer, floating header pills, toast alerts, and context menus) rely on multi-layered, low-opacity ambient drop shadows (`rgba(0, 0, 0, 0.04)` to `0.08`) combined with `1px` hairline borders (`rgba(0, 0, 0, 0.06)`).
3. **Left-Aligned Hero Axis**: Unlike competing chat UIs that center-align the greeting text above the prompt box, the hero heading (`"What can I do for you?"`), the prompt container, and the quick-action suggestion pills all share a **strict left-aligned vertical axis**.
4. **Progressive Reasoning Disclosure**: Assistant chain-of-thought is tucked behind an inline `"Show thinking >"` button and rendered inside a collapsible right-hand inspector drawer (`Steps` / `Sources`) featuring a vertical node timeline.

---

## 2. Color Tokens & Surface Palette

```css
:root {
  /* Surfaces */
  --bg-canvas: #FFFFFF;               /* Main viewport & sidebar background */
  --bg-surface-elevated: #FFFFFF;     /* Composer, floating pills, dropdowns, toasts */
  --bg-surface-subtle: #F4F4F5;       /* User chat bubble, active sidebar item, segmented track */
  --bg-surface-hover: #EFEFF1;        /* Sidebar hover, modal selected row ("New chat") */
  --bg-glass-backdrop: rgba(255, 255, 255, 0.60); /* ⌘K modal full-screen overlay */
  --bg-glass-modal: linear-gradient(
    180deg,
    rgba(246, 246, 248, 0.92) 0%,
    rgba(255, 255, 255, 0.98) 100%
  );

  /* Typography Hierarchy */
  --text-primary: #09090B;            /* Headings, body copy, nav labels, pill text */
  --text-secondary: #52525B;          /* Step descriptions, secondary icons */
  --text-muted: #71717A;              /* "Show thinking >", "History" header, inactive tab */
  --text-subtle: #A1A1AA;             /* Input placeholder ("Ask Meta AI..."), ⇧⌘O, ⌘K, dates */

  /* Brand & Accents */
  --brand-muse-violet: #7C3AED;       /* Primary pinwheel petal start */
  --brand-muse-purple: #9333EA;       /* Primary pinwheel petal mid */
  --brand-muse-periwinkle: #8B9CFE;   /* Composer send button (↑) fill */
  --brand-muse-periwinkle-hover: #7589FE;
  --accent-unread-blue: #2563EB;      /* 6px active/unread dot in sidebar history */

  /* Semantic Status */
  --status-success: #16A34A;          /* Toast checkmark ("Link copied to clipboard") */
  --status-danger: #DC2626;           /* "Delete chat" text & trash icon */

  /* Borders & Dividers */
  --border-hairline: rgba(0, 0, 0, 0.06);
  --border-control: #E4E4E7;          /* +, Instant, and Mic button outlines */
  --border-pill: #EBEBEF;             /* Quick-action suggestion pills */
  --border-drawer: #F1F1F4;           /* Right inspector drawer left border & menu divider */

  /* Elevation Shadows */
  --shadow-composer: 
    0 10px 36px -4px rgba(0, 0, 0, 0.06),
    0 2px 10px -2px rgba(0, 0, 0, 0.04),
    0 0 0 1px rgba(0, 0, 0, 0.05);
  --shadow-floating-pill: 
    0 2px 10px rgba(0, 0, 0, 0.05),
    0 0 0 1px rgba(0, 0, 0, 0.04);
  --shadow-dropdown: 
    0 12px 32px -4px rgba(0, 0, 0, 0.08),
    0 2px 6px -1px rgba(0, 0, 0, 0.04),
    0 0 0 1px rgba(0, 0, 0, 0.06);
  --shadow-toast: 
    0 14px 40px -6px rgba(0, 0, 0, 0.09),
    0 2px 8px -2px rgba(0, 0, 0, 0.04);
  --shadow-modal: 
    0 24px 60px -8px rgba(0, 0, 0, 0.10),
    0 4px 16px -4px rgba(0, 0, 0, 0.04),
    0 0 0 1px rgba(0, 0, 0, 0.06);
}
3. Typography System
Font Stack
Meta's web UI uses its proprietary Optimistic Display (headers) and Optimistic Text (UI/body) family by Dalton Maag, falling back to system UI fonts. To replicate the exact look with open-source web fonts, load Inter (with single-story a and open apertures enabled) or Plus Jakarta Sans:

CSS
:root {
  --font-display: 'Optimistic Display', 'Plus Jakarta Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif;
  --font-sans: 'Optimistic Text', 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
}

body {
  font-family: var(--font-sans);
  color: var(--text-primary);
  background-color: var(--bg-canvas);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  font-feature-settings: "cv02" 1, "cv03" 1, "cv04" 1, "cv11" 1; /* Single-story 'a' & open apertures in Inter */
}
Type Scale & Specifications
UI Element	Font Family	Size	Weight	Line Height	Tracking	Color
Hero Greeting (What can I do for you?)	var(--font-display)	28px (1.75rem)	400 / 450	1.2 (34px)	-0.022em	#09090B
Composer Input / Placeholder (Ask Meta AI...)	var(--font-sans)	15.5px (0.968rem)	400	1.5 (24px)	-0.01em	#09090B / #A1A1AA
Chat Message Body (User & Assistant)	var(--font-sans)	15px (0.9375rem)	400	1.6 (24px)	-0.005em	#09090B
Sidebar Nav & History Items	var(--font-sans)	13.5px (0.843rem)	400 (600 active)	1.4 (19px)	-0.005em	#09090B
Sidebar Keyboard Shortcuts (⇧⌘O, ⌘K)	var(--font-sans)	12px (0.75rem)	400	1.0	0.02em	#A1A1AA
Section Subheaders (History, Recent)	var(--font-sans)	11.5px (0.718rem)	500	1.2	0.01em	#71717A
Pills & Top Title Badge (Instant, Discover)	var(--font-sans)	13px (0.8125rem)	500	1.0	-0.01em	#09090B
Inspector Step Title (Greeting warmly)	var(--font-sans)	13px (0.8125rem)	500	1.4	-0.01em	#18181B
Inspector Step Body	var(--font-sans)	12.5px (0.781rem)	400	1.55	0em	#71717A
4. Layout & Spatial Grid Architecture
The application uses a full-viewport (100vw × 100vh, overflow: hidden) 3-column flexbox/grid shell:

Plaintext
+-----------------------+--------------------------------------------------+----------------------------+
| Left Navigation       | Main Workspace Canvas (flex: 1)                  | Right Inspector Drawer     |
| Width: 248px (fixed)  | Min-width: 0, Position: relative                 | Width: 340px (collapsible) |
| Border-right: NONE    | Max content column width: 700px (centered)       | Border-left: 1px #F1F1F4   |
+-----------------------+--------------------------------------------------+----------------------------+
5. Component-by-Component Specifications
5.1 Left Navigation Sidebar
Container: width: 248px; height: 100vh; padding: 14px 12px; display: flex; flex-direction: column; background: #FFFFFF; user-select: none;

Top Header Row: display: flex; align-items: center; justify-content: space-between; padding: 4px 8px 20px 8px;

Left: Meta Muse 7-Petal Pinwheel Logo (22px × 22px SVG). Seven rotated teardrop petals arranged radially in a clockwise swirl with a purple-to-periwinkle gradient (#7C3AED → #9333EA → #8B9CFE).

Right: Sidebar Collapse Button (28px × 28px, border-radius: 6px, icon: 18px × 14px rounded rectangle with vertical left pane divider, stroke 1.5px, color #52525B).

Primary Action List: Vertical stack (display: flex; flex-direction: column; gap: 2px;):

Each row: height: 36px; padding: 0 10px; border-radius: 10px; display: flex; align-items: center; gap: 12px; font-size: 13.5px; color: #09090B; cursor: pointer;

Hover state: background-color: #F4F4F5;

Icons (17px × 17px, 1.6px stroke width, #18181B):

New chat (Square with diagonal pencil) + right-aligned ⇧⌘O (margin-left: auto; color: #A1A1AA; font-size: 12px;)

Search (Magnifying glass) + right-aligned ⌘K (margin-left: auto; color: #A1A1AA; font-size: 12px;)

Media (Rounded square picture frame with mountain/sun)

Artifacts (2×2 geometric grid: circle, triangle, square, 4-point star)

Scheduled (Calendar outline with dotted grid)

Vibes (Rounded square with centered play triangle)

History Section:

Header: "History" (margin-top: 24px; padding: 0 10px 8px 10px; font-size: 11.5px; font-weight: 500; color: #71717A;)

History Item Row: height: 34px; padding: 0 10px; border-radius: 10px; display: flex; align-items: center; justify-content: space-between; font-size: 13.5px; color: #18181B; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;

Active History Row: background-color: #F4F4F5; font-weight: 600; color: #09090B;

Unread / Active Dot: When a background response finishes (e.g., "Quick hello"), render a 6px × 6px solid circle (background: #2563EB; border-radius: 9999px; flex-shrink: 0;) on the right edge of the row.

5.2 Empty State Hero & Prompt Composer
Positioning: Inside the main canvas, center a wrapper of width: 100%; max-width: 680px; positioned slightly above vertical center (margin-top: -6vh).

Hero Greeting ("What can I do for you?"):

Alignment: Strictly left-aligned (text-align: left; padding-left: 2px; margin-bottom: 20px;).

Style: font-size: 28px; font-weight: 400; letter-spacing: -0.022em; color: #09090B;

Prompt Composer Box:

Container:

CSS
.composer-card {
  width: 100%;
  min-height: 116px;
  background: #FFFFFF;
  border-radius: 26px;
  padding: 18px 18px 14px 20px;
  box-shadow: var(--shadow-composer);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  transition: box-shadow 0.2s ease;
}
Textarea: Unstyled transparent <textarea> (width: 100%; resize: none; border: none; outline: none; font-size: 15.5px; line-height: 1.5; color: #09090B;), placeholder "Ask Meta AI..." in #A1A1AA.

Bottom Control Bar: display: flex; align-items: center; justify-content: space-between; margin-top: 12px;

Left Attachment Button (+): width: 32px; height: 32px; border-radius: 9999px; border: 1px solid #E4E4E7; background: #FFFFFF; display: grid; place-items: center; color: #18181B;

Right Control Cluster (display: flex; align-items: center; gap: 8px;):

Mode Pill (Instant): height: 32px; padding: 0 14px; border-radius: 9999px; border: 1px solid #E4E4E7; background: #FFFFFF; font-size: 13px; font-weight: 500; color: #09090B;

Voice Input Button (Microphone): width: 32px; height: 32px; border-radius: 9999px; border: 1px solid #E4E4E7; background: #FFFFFF; display: grid; place-items: center; color: #18181B;

Submit Button (↑): width: 32px; height: 32px; border-radius: 9999px; background: #8B9CFE; border: none; display: grid; place-items: center; color: #FFFFFF; cursor: pointer;

Quick-Action Suggestion Chips:

Container: display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; justify-content: flex-start; (left-aligned with the composer!).

Chip Style (Discover, Ask anything, Take action, Create images):

CSS
.suggestion-pill {
  height: 32px;
  padding: 0 14px;
  background: #FFFFFF;
  border: 1px solid #EBEBEF;
  border-radius: 9999px;
  font-size: 13px;
  font-weight: 500;
  color: #09090B;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
}
.suggestion-pill:hover {
  background: #F9F9FB;
  border-color: #DCDCE0;
}
5.3 Active Conversation View & Floating Header
Top Floating Bar: Positioned at the top of the main chat canvas (position: sticky; top: 0; z-index: 10; display: flex; justify-content: space-between; align-items: center; padding: 14px 20px; pointer-events: none;):

Left Chat Title Pill: Floating white pill (pointer-events: auto; background: #FFFFFF; padding: 7px 16px; border-radius: 9999px; box-shadow: var(--shadow-floating-pill); font-size: 13px; font-weight: 500; color: #09090B;) — or plain text (font-size: 14px; font-weight: 500;) when the header flattens.

Right Action Buttons: Two circular floating buttons (width: 32px; height: 32px; border-radius: 9999px; background: #FFFFFF; box-shadow: var(--shadow-floating-pill); display: grid; place-items: center; gap: 8px;):

Share Button: Paper-plane (send) stroke icon (15px).

More Menu Button: Horizontal 3-dot ellipsis (•••) icon (15px).

Message Stream Container: max-width: 700px; margin: 0 auto; padding: 24px 20px 140px 20px; display: flex; flex-direction: column; gap: 24px;

User Message Bubble:

Alignment: align-self: flex-end; max-width: 72%;

Surface: background: #F4F4F5; color: #09090B; font-size: 15px; line-height: 1.5;

Shape Adaptation:

Single short line (e.g., "Hey!"): padding: 10px 18px; border-radius: 9999px;

Multi-line or with media attachments: padding: 14px 18px; border-radius: 20px;

Reference Media Thumbnails: Displayed inside the bubble as a horizontal row of 44px × 44px rounded squares (border-radius: 8px; object-fit: cover; gap: 8px; margin-top: 10px;).

Assistant Response Block:

Alignment: align-self: flex-start; width: 100%; (No background bubble).

Thinking Trigger Row: display: inline-flex; align-items: center; gap: 8px; margin-bottom: 10px; cursor: pointer;

Left: 16px × 16px animated/static purple 7-petal Muse icon.

Right: "Show thinking" (font-size: 13px; font-weight: 500; color: #71717A;) + right chevron > (12px, #71717A).

Prose Body: font-size: 15px; line-height: 1.6; color: #09090B; display: flex; flex-direction: column; gap: 12px;

Generated Video / Image Card: margin-top: 16px; width: 100%; max-width: 540px; border-radius: 18px; overflow: hidden; background: #000000; position: relative;

Response Action Bar: Below the assistant text (display: flex; align-items: center; gap: 14px; margin-top: 12px; color: #71717A;):

4 minimal stroke icons (15px × 15px, 1.5px stroke, hover color #09090B): Thumbs Up, Thumbs Down, Copy (overlapping squares), Share (upload tray).

Bottom Sticky Composer: Docked at bottom: 18px; left: 50%; transform: translateX(-50%); width: calc(100% - 40px); max-width: 680px; with a subtle white bottom gradient mask behind it.

5.4 Right Inspector Drawer (Steps & Sources)
Container: width: 340px; height: 100vh; border-left: 1px solid #F1F1F4; background: #FFFFFF; padding: 14px 20px; display: flex; flex-direction: column; overflow-y: auto;

Top Close Row: display: flex; justify-content: flex-end; margin-bottom: 12px; with a 24px × 24px close ✕ icon (#52525B).

Segmented Pill Switcher (Steps | Sources):

Track: background: #F4F4F5; padding: 3px; border-radius: 9999px; display: grid; grid-template-columns: 1fr 1fr; margin-bottom: 24px;

Active Tab (Steps): background: #FFFFFF; border-radius: 9999px; padding: 6px 0; text-align: center; font-size: 13px; font-weight: 600; color: #09090B; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);

Inactive Tab (Sources): background: transparent; padding: 6px 0; text-align: center; font-size: 13px; font-weight: 500; color: #52525B;

Vertical Chain-of-Thought Timeline:

Structure: Left vertical rail (position: relative; padding-left: 20px;) with a continuous 1px solid #E4E4E7 vertical line running along left: 4px.

Step Item: margin-bottom: 20px; position: relative;

Node Dot: width: 5px; height: 5px; border-radius: 9999px; background: #52525B; position: absolute; left: -18px; top: 7px; box-shadow: 0 0 0 4px #FFFFFF;

Step Heading: font-size: 13px; font-weight: 500; color: #18181B; margin-bottom: 4px;

Step Narrative: font-size: 12.5px; line-height: 1.55; color: #71717A;

Optional Step Media Preview: width: 60px; height: 60px; border-radius: 10px; object-fit: cover; margin-top: 10px; position: relative; (with centered translucent play icon overlay).

Terminal Node (Done):

Icon: 12px × 12px muted circle (border: 1px solid #D4D4D8; color: #A1A1AA) with a tiny checkmark ✓ at left: -21px; top: 3px; background: #FFFFFF;

Label: "Done" (font-size: 12.5px; font-weight: 500; color: #71717A;).

5.5 Command Palette / Search Modal (⌘K)
Full-Viewport Backdrop:

position: fixed; inset: 0; z-index: 50; background: rgba(255, 255, 255, 0.55); backdrop-filter: blur(18px) saturate(140%); display: grid; place-items: center;

Modal Dialog Card:

width: 520px; height: 470px; border-radius: 22px; background: var(--bg-glass-modal); backdrop-filter: blur(24px); box-shadow: var(--shadow-modal); display: flex; flex-direction: column; overflow: hidden;

Search Header:

display: flex; align-items: center; justify-content: space-between; padding: 18px 20px 14px 20px; border-bottom: 1px solid rgba(0, 0, 0, 0.06);

Input: font-size: 15px; color: #09090B; with placeholder "Search chats" (#71717A).

Close Button: width: 22px; height: 22px; border-radius: 9999px; background: #E4E4E7; color: #52525B; display: grid; place-items: center; font-size: 11px;

Modal Body: padding: 12px 12px; display: flex; flex-direction: column; gap: 4px;

Selected / Default Action Row (New chat):

height: 38px; padding: 0 12px; border-radius: 10px; background: #EFEFF1; display: flex; align-items: center; gap: 10px; font-size: 13.5px; font-weight: 500; color: #09090B;

Section Label (Recent):

padding: 14px 12px 6px 12px; font-size: 11.5px; font-weight: 500; color: #71717A;

Recent Result Row:

height: 36px; padding: 0 12px; border-radius: 10px; display: flex; align-items: center; justify-content: space-between; font-size: 13.5px; color: #09090B; cursor: pointer;

Right Timestamp (Oct 30, Apr 15): font-size: 12px; color: #A1A1AA; font-variant-numeric: tabular-nums;

5.6 Floating Toast & Context Menu Overlays
Top-Center Clipboard Toast ("Link copied to clipboard"):

Position: position: fixed; top: 18px; left: 50%; transform: translateX(-50%); z-index: 60;

Card: background: #FFFFFF; border-radius: 18px; padding: 14px 22px; box-shadow: var(--shadow-toast); display: inline-flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 500; color: #09090B;

Checkmark Icon: 16px × 16px stroke checkmark in #16A34A (stroke-width: 2.2px).

Top-Right More (•••) Dropdown Menu:

Position: Anchored 8px below the top-right ••• button (right: 20px; top: 52px; z-index: 40;).

Card: width: 210px; background: #FFFFFF; border-radius: 16px; padding: 6px; box-shadow: var(--shadow-dropdown); display: flex; flex-direction: column; gap: 2px;

Menu Row (Pin, Rename): height: 36px; padding: 0 12px; border-radius: 10px; display: flex; align-items: center; gap: 10px; font-size: 13.5px; font-weight: 400; color: #09090B; cursor: pointer;

Hover/Active state: background: #F4F4F5;

Divider: height: 1px; background: #F1F1F4; margin: 4px 6px;

Destructive Row (Delete chat): Same geometry as standard menu row, with both icon (trash can) and label colored #DC2626 (hover background rgba(220, 38, 38, 0.06)).

6. Reusable SVG Assets (Meta Muse Pinwheel Logo)
Use this inline SVG to render the 7-petal radial Meta Muse mark at 22px × 22px (sidebar) or 16px × 16px (Show thinking indicator):

HTML
<svg width="22" height="22" viewBox="0 0 32 32" fill="none" xmlns="[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)">
  <defs>
    <linearGradient id="museGrad" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#A855F7" />
      <stop offset="50%" stop-color="#7C3AED" />
      <stop offset="100%" stop-color="#6366F1" />
    </linearGradient>
  </defs>
  <g fill="url(#museGrad)">
    <ellipse cx="16" cy="6.5" rx="2.4" ry="4.8" transform="rotate(15 16 6.5)" />
    <ellipse cx="23.5" cy="10" rx="2.4" ry="4.8" transform="rotate(66 23.5 10)" />
    <ellipse cx="25" cy="18" rx="2.4" ry="4.8" transform="rotate(117 25 18)" />
    <ellipse cx="20" cy="24.5" rx="2.4" ry="4.8" transform="rotate(168 20 24.5)" />
    <ellipse cx="12" cy="24.5" rx="2.4" ry="4.8" transform="rotate(219 12 24.5)" />
    <ellipse cx="7" cy="18" rx="2.4" ry="4.8" transform="rotate(270 7 18)" />
    <ellipse cx="8.5" cy="10" rx="2.4" ry="4.8" transform="rotate(321 8.5 10)" />
  </g>
</svg>

Would you like me to generate the complete Next.js 15 + Tailwind CSS + Lucide React interactive prototype for this interface so you can run all five states locally?
Also

Newly Captured UI States & Patterns (Screenshots 6–10)
Time-Aware Hero Greeting & Reasoning Mode Toggle: The hero heading dynamically updates by time of day ("What are you thinking this afternoon?"), and the composer mode pill toggles between "Instant" and "Thinking".   
Screenshot 2026-10-31 at 2.19.08 PM.png
+ 1

Interactive Quick-Action Tabs (Discover & Create images):

Clicking one of the four pills below the composer (Discover, Ask anything, Take action, Create images) switches it from a white bordered pill (#FFFFFF fill, #EBEBEF border) to an active filled pill (#EFEFF1 fill, transparent border) and reveals a category tray below:   
Screenshot 2026-10-31 at 2.19.08 PM.png
+ 2

Discover Grid: A 3-column × 2-row grid of horizontal starter items pairing a 52px × 52px soft grey squircle icon box (#EFEFF1, border-radius: 14px) with a 2-line medium-weight prompt label (Get this week's forecast, Catch up on today's AI news, Create a 20 min daily workout, Explore today in history, Explain what a data center is, Recap calendar and email).   
Screenshot 2026-10-31 at 2.22.36 PM.png

Create images Media Strip: A 5-column horizontal row of portrait thumbnail cards (border-radius: 18px, aspect-ratio: 0.86) with full-bleed photography, a bottom dark scrim gradient, and bottom-left white captions (GIF me a break, 16 styles, Aquarium room, UFC Sticker Pack, Movie poster featuring me).   
Screenshot 2026-10-31 at 2.22.45 PM.jpg

Voice Dictation (Listening...) Composer State: Activating the microphone replaces "Ask Meta AI..." with "Listening...", converts the bottom-left + button into a cancel (✕) button, replaces the mode and mic buttons with a dual waveform-dots + stop-square pill (••• + ⏹), and shifts the send button (↑) from soft periwinkle (#8B9CFE) to vibrant Cobalt Blue (#3563F6).   
Screenshot 2026-10-31 at 2.22.36 PM.png
+ 1

Sidebar User Footer & Profile Popover Menu: The bottom of the left sidebar houses a user bar (32px avatar + username ethan.a.castro + notification bell icon) that opens a 232px-wide floating popover card segmented into four icon-led groups (View profile, Apps, Settings, Keyboard shortcuts ⌘/ | Vibes.ai ↗, AI Demos ↗, AI identification | Download Meta AI > | Sign Out) plus an embedded legal footer (Meta © 2026 and Privacy · Terms · AI Terms · Cookies).   
Screenshot 2026-10-31 at 2.22.59 PM.png

Live Streaming Reasoning & Artifact Builder Rail: While actively generating code or reasoning (before collapsing into "Show thinking >"), the purple 7-petal Muse pinwheel sits alongside the active step title ("Building resume builder styles"), and a 1.5px vertical purple gradient line (rgba(168,85,247,0.2) → #7C3AED) extends downward beneath the pinwheel to frame the live-streaming reasoning summary.   
Screenshot 2026-10-31 at 2.19.57 PM.jpg
+ 1

Master Consolidated BRAND.md (All 10 Screenshots)
Save this complete specification as BRAND.md in your project root:

Markdown
# Meta AI (Muse Web UI) — Complete Brand & UI Recreation Guide (`BRAND.md`)

## 1. Visual Philosophy & Core Architecture
The 2026 Meta AI (`meta.ai` / Muse) web application is a high-key, daylight-first workspace designed around five structural rules:
1. **Zero-Chrome White Canvas**: Both the main viewport and the left sidebar share a pure `#FFFFFF` surface with **no vertical border line** between them; separation is achieved strictly via layout geometry and whitespace.
2. **Ambient Elevation Over Hard Borders**: Floating surfaces (composer card, header pills, profile menu, command palette, and toast alerts) use multi-layered, low-opacity drop shadows (`0.04–0.10` alpha) paired with `1px` hairline borders (`rgba(0, 0, 0, 0.06)`).
3. **Strict Left-Aligned Hero Axis**: The dynamic greeting (`"What can I do for you?"` / `"What are you thinking this afternoon?"`), the composer box, the 4 category pills, and the expandable starter grids all align to a single left vertical axis (`max-width: 680px`).
4. **Borderless Assistant Prose**: User prompts sit inside right-aligned `#F4F4F5` bubbles, whereas assistant responses render directly on the `#FFFFFF` canvas without background containers.
5. **Two-Stage Reasoning Disclosure**:
   - **During Generation**: Displays inline with the 7-petal purple Muse pinwheel, an active step heading, and a vertical purple gradient left rail framing the live step description.
   - **After Completion**: Collapses into a compact `"Show thinking >"` button that opens a `340px` right-hand inspector drawer (`Steps` / `Sources`).

---

## 2. Design Tokens & Color Palette

```css
:root {
  /* Core Surfaces */
  --bg-canvas: #FFFFFF;                /* Main viewport & left sidebar */
  --bg-elevated: #FFFFFF;              /* Composer, popovers, dropdowns, floating pills */
  --bg-subtle: #F4F4F5;                /* User chat bubble, active sidebar row, segmented track */
  --bg-pill-active: #EFEFF1;           /* Active quick-action pill ("Discover", "Create images") & icon squircles */
  --bg-hover: #F4F4F5;                 /* Standard hover background for nav and menu rows */
  --bg-modal-backdrop: rgba(255, 255, 255, 0.58);
  --bg-modal-surface: linear-gradient(
    180deg,
    rgba(246, 246, 248, 0.94) 0%,
    rgba(255, 255, 255, 0.99) 100%
  );

  /* Typography Colors */
  --text-primary: #09090B;             /* Headings, chat prose, nav labels, menu items */
  --text-secondary: #52525B;           /* Active streaming reasoning text, secondary icons */
  --text-muted: #71717A;               /* "Show thinking >", "History", "Listening...", legal footer */
  --text-subtle: #A1A1AA;              /* "Ask Meta AI...", keyboard shortcuts (⇧⌘O, ⌘K, ⌘/), dates */

  /* Brand & Interactive Accents */
  --brand-muse-violet: #7C3AED;        /* Pinwheel primary stop & streaming vertical rail */
  --brand-muse-purple: #A855F7;        /* Pinwheel highlight stop */
  --brand-send-idle: #8B9CFE;          /* Default composer send button (↑) periwinkle fill */
  --brand-send-active: #3563F6;        /* Active/Voice composer send button (↑) cobalt blue fill */
  --accent-unread-dot: #2563EB;        /* 6px unread indicator dot in sidebar chat history */

  /* Semantic Status */
  --status-success: #16A34A;           /* Clipboard toast checkmark */
  --status-danger: #DC2626;            /* "Delete chat" destructive action */

  /* Borders & Hairlines */
  --border-hairline: rgba(0, 0, 0, 0.06);
  --border-control: #E4E4E7;           /* Composer buttons (+, ✕, Instant/Thinking, Mic, Stop pill) */
  --border-pill: #EBEBEF;              /* Inactive quick-action suggestion pills */
  --border-divider: #F1F1F4;           /* Right drawer border & popover menu dividers */

  /* Elevation Shadows */
  --shadow-composer:
    0 10px 36px -4px rgba(0, 0, 0, 0.06),
    0 2px 10px -2px rgba(0, 0, 0, 0.04),
    0 0 0 1px rgba(0, 0, 0, 0.05);
  --shadow-pill:
    0 2px 10px rgba(0, 0, 0, 0.05),
    0 0 0 1px rgba(0, 0, 0, 0.04);
  --shadow-popover:
    0 12px 36px -4px rgba(0, 0, 0, 0.08),
    0 2px 8px -1px rgba(0, 0, 0, 0.04),
    0 0 0 1px rgba(0, 0, 0, 0.06);
  --shadow-toast:
    0 14px 40px -6px rgba(0, 0, 0, 0.09),
    0 2px 8px -2px rgba(0, 0, 0, 0.04);
  --shadow-modal:
    0 24px 60px -8px rgba(0, 0, 0, 0.10),
    0 4px 16px -4px rgba(0, 0, 0, 0.04),
    0 0 0 1px rgba(0, 0, 0, 0.06);
}
3. Typography System
Proprietary Font & Open-Source Web Fallback
Meta uses Optimistic Display (headings) and Optimistic Text (UI/body), custom-designed by Dalton Maag. It is a neo-grotesque/geometric hybrid with a single-story lowercase a and wide apertures. For web recreation without Meta internal CDN access, configure Inter (with stylistic alternates enabled) + Plus Jakarta Sans:

CSS
:root {
  --font-display: 'Optimistic Display', 'Plus Jakarta Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif;
  --font-sans: 'Optimistic Text', 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
}

body {
  font-family: var(--font-sans);
  color: var(--text-primary);
  background: var(--bg-canvas);
  -webkit-font-smoothing: antialiased;
  font-feature-settings: "cv02" 1, "cv03" 1, "cv04" 1, "cv11" 1; /* Enables single-story 'a' & open apertures in Inter */
}
Type Scale Table
Element	Font	Size	Weight	Line Height	Tracking	Color
Hero Greeting (What are you thinking...)	var(--font-display)	28px	400	1.2 (34px)	-0.022em	#09090B
Composer Input / Listening...	var(--font-sans)	15.5px	400	1.5 (24px)	-0.01em	#09090B / #A1A1AA
Chat Prose (User & Assistant)	var(--font-sans)	15px	400	1.6 (24px)	-0.005em	#09090B
Live Streaming Reasoning Text	var(--font-sans)	14px	400	1.55 (22px)	-0.005em	#52525B
Sidebar Nav, History & Popover Items	var(--font-sans)	13.5px	400 (600 active)	1.4 (19px)	-0.005em	#09090B
Discover Card 2-Line Prompt Label	var(--font-sans)	13.5px	500	1.35 (18px)	-0.01em	#09090B
Mode & Category Pills (Thinking, Discover)	var(--font-sans)	13px	500	1.0	-0.01em	#09090B
Image Card Overlay Caption	var(--font-sans)	12.5px	500	1.25	-0.01em	#FFFFFF
Inspector Step Title / Body	var(--font-sans)	13px / 12.5px	500 / 400	1.4 / 1.55	-0.01em	#18181B / #71717A
Shortcuts (⇧⌘O, ⌘K, ⌘/) & Legal Footer	var(--font-sans)	12px	400	1.35	0.01em	#A1A1AA / #71717A
4. App Shell Layout (100vw × 100vh)
Plaintext
+-------------------------+--------------------------------------------------+----------------------------+
| Left Navigation Sidebar | Center Workspace Canvas (flex: 1)                | Right Inspector Drawer     |
| Width: 248px (fixed)    | Pure #FFFFFF background                          | Width: 340px (collapsible) |
| Border-right: NONE      | Hero & Chat column max-width: 680px–700px        | Border-left: 1px #F1F1F4   |
| Top: Logo + Nav + Hist  | Floating top header + sticky bottom composer     | Segmented: Steps | Sources |
| Bottom: User Profile    |                                                  | Vertical node timeline     |
+-------------------------+--------------------------------------------------+----------------------------+
5. Detailed Component Specifications
5.1 Left Sidebar & User Profile Popover
Sidebar Container: width: 248px; height: 100vh; padding: 14px 12px; display: flex; flex-direction: column; background: #FFFFFF;

Top Brand Row: padding: 4px 8px 20px 8px; display: flex; justify-content: space-between; align-items: center;

Left: 22px × 22px 7-petal radial purple Meta Muse pinwheel SVG.

Right: Sidebar toggle icon (18px × 14px split-pane rounded rectangle, 1.5px stroke, #52525B).

Primary Nav Links (gap: 2px):

Row height 36px, padding: 0 10px, border-radius: 10px, gap: 12px, font-size: 13.5px.

Items:

New chat (compose square-pencil icon) + right-aligned ⇧⌘O (#A1A1AA)

Search (magnifying glass) + right-aligned ⌘K (#A1A1AA)

Media (framed landscape icon)

Artifacts (2×2 geometric shapes icon: circle, triangle, square, star)

Scheduled (calendar outline icon)

Vibes (rounded play square icon)

History List:

Section Label "History": margin-top: 24px; padding: 0 10px 8px; font-size: 11.5px; font-weight: 500; color: #71717A;

Row: height: 34px; padding: 0 10px; border-radius: 10px; font-size: 13.5px; display: flex; align-items: center; justify-content: space-between;

Active State: background: #F4F4F5; font-weight: 600;

Unread Indicator: 6px × 6px circle in #2563EB on the right edge.

Bottom User Profile Bar:

margin-top: auto; padding: 10px 8px 4px; display: flex; align-items: center; justify-content: space-between; cursor: pointer;

Left: 32px × 32px circular user avatar + username (font-size: 13.5px; font-weight: 500; color: #09090B; margin-left: 10px;).

Right: Notification bell icon (18px × 18px, 1.6px stroke, #52525B).

User Profile Popover Menu:

Position: position: absolute; bottom: 56px; left: 12px; width: 232px; background: #FFFFFF; border-radius: 20px; padding: 8px; box-shadow: var(--shadow-popover); z-index: 40;

Menu Rows: height: 36px; padding: 0 10px; border-radius: 10px; display: flex; align-items: center; gap: 12px; font-size: 13.5px; color: #09090B;

Group 1: View profile (user-circle icon), Apps (2×2 circle grid), Settings (gear-compass), Keyboard shortcuts (keyboard icon + right-aligned ⌘/ in #A1A1AA).

Divider: height: 1px; background: #F1F1F4; margin: 6px 8px;

Group 2: Vibes.ai (play circle + right ↗), AI Demos (2×2 squircle grid + right ↗), AI identification (scan brackets icon).

Divider: height: 1px; background: #F1F1F4; margin: 6px 8px;

Group 3: Download Meta AI (desktop smiley monitor icon + right chevron >).

Divider: height: 1px; background: #F1F1F4; margin: 6px 8px;

Group 4: Sign Out (exit bracket arrow icon).

Embedded Legal Footer: padding: 10px 10px 6px; font-size: 12px; color: #71717A; line-height: 1.45;

Line 1: Meta © 2026

Line 2: Privacy · Terms · AI Terms · Cookies

5.2 Prompt Composer (Idle, Thinking & Voice Dictation States)
Card Shell: width: 100%; max-width: 680px; min-height: 116px; background: #FFFFFF; border-radius: 26px; padding: 18px 18px 14px 20px; box-shadow: var(--shadow-composer); display: flex; flex-direction: column; justify-content: space-between;

State A — Default / Text Input Mode:

Top Textarea: font-size: 15.5px; color: #09090B; with placeholder "Ask Meta AI..." (#A1A1AA).

Bottom Left: Circular + button (32px × 32px, border: 1px solid #E4E4E7, border-radius: 9999px).

Bottom Right Cluster (gap: 8px):

Mode Pill: Toggles between "Instant" and "Thinking" (height: 32px; padding: 0 14px; border-radius: 9999px; border: 1px solid #E4E4E7; background: #FFFFFF; font-size: 13px; font-weight: 500; color: #09090B;).

Microphone Button: 32px × 32px circular outline button (border: 1px solid #E4E4E7).

Submit Button (↑): 32px × 32px solid circle in #8B9CFE (periwinkle) when empty/idle, white ↑ icon.

State B — Voice Dictation (Listening...) Mode:

Top Status Text: "Listening..." in #71717A (font-size: 15.5px).

Bottom Left: Circular Cancel ✕ button (32px × 32px, border: 1px solid #E4E4E7, border-radius: 9999px).

Bottom Right Cluster (gap: 8px):

Waveform + Stop Pill: height: 32px; padding: 0 12px; border-radius: 9999px; border: 1px solid #E4E4E7; background: #FFFFFF; display: inline-flex; align-items: center; gap: 14px;

Left: 3 horizontal animated voice dots (•••, 3.5px diameter each, #09090B).

Right: Stop square icon (13px × 13px, border: 1.6px solid #09090B, border-radius: 3px).

Active Submit Button (↑): 32px × 32px solid circle in vibrant Cobalt Blue (#3563F6), white ↑ icon.

5.3 Quick-Action Category Pills & Expandable Starter Grids
Category Pill Bar: display: flex; gap: 8px; margin-top: 16px; justify-content: flex-start;

Pills: Discover, Ask anything, Take action, Create images.

Inactive Pill: height: 32px; padding: 0 14px; border-radius: 9999px; background: #FFFFFF; border: 1px solid #EBEBEF; font-size: 13px; font-weight: 500; color: #09090B;

Active / Selected Pill: background: #EFEFF1; border-color: transparent; color: #09090B;

Tray Variant 1 — Discover Starter Grid (3×2 Icon + Label Grid):

Container: display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px 24px; margin-top: 20px; width: 100%; max-width: 680px;

Item Card: display: flex; align-items: center; gap: 14px; cursor: pointer; border-radius: 14px; transition: opacity 0.15s ease;

Icon Squircle: width: 52px; height: 52px; border-radius: 14px; background: #EFEFF1; display: grid; place-items: center; flex-shrink: 0; (20px × 20px stroke icon, 1.6px stroke, #09090B).

Prompt Label: font-size: 13.5px; font-weight: 500; line-height: 1.35; color: #09090B; max-width: 135px;

Tray Variant 2 — Create images Media Strip (5-Column Visual Cards):

Container: display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-top: 20px; width: 100%; max-width: 680px;

Visual Card: aspect-ratio: 0.88; border-radius: 18px; overflow: hidden; position: relative; cursor: pointer; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);

Scrim Overlay: position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,0) 45%, rgba(0,0,0,0.68) 100%);

Caption: position: absolute; bottom: 10px; left: 12px; right: 10px; font-size: 12.5px; font-weight: 500; line-height: 1.25; color: #FFFFFF;

5.4 Active Chat Stream, Live Streaming Reasoning & Right Inspector
Top Floating Header:

Left: Chat title inside a floating white pill (padding: 7px 16px; border-radius: 9999px; box-shadow: var(--shadow-pill); font-size: 13px; font-weight: 500;) or plain header text (14px, 500 weight).

Right: 32px × 32px circular Share (paper-plane) and More (•••) buttons (box-shadow: var(--shadow-pill)).

User Bubble: Right-aligned (align-self: flex-end), background: #F4F4F5, color: #09090B, font-size: 15px, padding: 10px 18px, border-radius: 9999px (single line) or 20px (multi-line/media).

Assistant Reasoning — State 1 (Live Streaming / Building):

Header Row: display: flex; align-items: center; gap: 10px; margin-bottom: 6px;

16px × 16px rotating purple 7-petal Muse pinwheel.

Active step title (e.g., "Building resume builder styles"): font-size: 14px; font-weight: 400; color: #52525B;

Streaming Body with Purple Gradient Rail:

margin-left: 7px; padding-left: 17px; border-left: 1.5px solid transparent; border-image: linear-gradient(180deg, rgba(168, 85, 247, 0.2) 0%, #7C3AED 100%) 1; font-size: 14px; line-height: 1.55; color: #52525B; max-width: 620px;

Assistant Reasoning — State 2 (Completed & Collapsed):

Trigger row: 16px × 16px purple Muse pinwheel + "Show thinking >" (font-size: 13px; font-weight: 500; color: #71717A;).

Clicking opens the 340px right inspector drawer (Steps | Sources segmented pill switcher + vertical 1px #E4E4E7 timeline rail with 5px #52525B node dots and terminal checkmark Done).

5.5 Modals, Dropdowns & Toasts
⌘K Search Modal: 520px × 470px frosted glass card (border-radius: 22px, box-shadow: var(--shadow-modal)) over a backdrop-filter: blur(18px) white-tinted overlay (rgba(255, 255, 255, 0.58)). Includes "Search chats" header with 22px circular ✕ button, highlighted "New chat" row (#EFEFF1), and "Recent" chat list with right-aligned tabular dates (Oct 30, Apr 15).

Top-Center Toast ("Link copied to clipboard"): Floating pill (border-radius: 18px; padding: 14px 22px; background: #FFFFFF; box-shadow: var(--shadow-toast);) with #16A34A checkmark icon.

Top-Right Chat Context Menu (•••): 210px white card (border-radius: 16px; padding: 6px; box-shadow: var(--shadow-popover);) with Pin, Rename, 1px divider, and #DC2626 Delete chat.





Gemini is AI and can make mistakes.

Incorporating new interface details
</pasted_content id="5d80">
