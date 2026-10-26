# UI component review, October 2026

Reference: Handy's latest stable release, [v0.9.8](https://github.com/cjpais/Handy/releases/tag/v0.9.8), commit `14f6f0d31cb22a4268acfbddba3052820fd0a06e`. GitHub's latest-release API was checked on 25 October. The reference checkout was read without running its install scripts.

Three agents reviewed release readiness, desktop leaf views, and the application shell/styles. The desktop review covered every render file under `src/`, including the meeting overlay. The website and separately bundled browser sign-in retain their own component systems.

## Component mapping

Handy uses its own React Button, Input, Textarea, Select, ToggleSwitch, Dialog, Alert, Badge, Tooltip, SettingContainer, and SettingsGroup components. Its styles use theme tokens and Tailwind, and its Select wraps react-select. Savvy can use the same component boundaries with its existing CSS and native accessible controls. A Tailwind or react-select migration is unnecessary for this change.

| Surface | Review coverage | Component convention |
| --- | --- | --- |
| Application shell and settings | Navigation, footer, updates, preferences, providers, shortcuts, directories, startup | Shared buttons and fields; existing grouped setting rows; specialized navigation and switches retain their layout |
| Prepare | Client selection, source tree, guidance, objective, brief generation/review | Shared buttons and fields; keyboard-operable selection; native disclosures |
| Connected sources | Provider/kind selectors, connect/disconnect, search, results, attachment/removal, refresh failures | Shared Button/Input/Select/Alert; explicit submit behavior; operation and empty-result feedback |
| Audio check | Ten buttons, two selectors, signal meters, diagnostic disclosure | Shared controls; native meter and details semantics |
| Onboarding | Provider cards, credentials, permissions, step navigation, dismissible errors | Shared controls with card/ghost variants; preserve step focus and pressed state |
| Managed account | Purchases, allowance, sign-in, offer radios, account actions | Shared buttons and notices; labeled fieldsets and radio inputs |
| Meeting readiness | Permissions, source failures, stale/exclude decisions, start actions | Shared buttons/notices; labeled opt-in checkbox and readiness description list |
| Live overlay and recommendations | Recording controls, stop confirmation, recommendation actions, cited excerpts | Specialized meeting layout; shared interaction states; accessible disclosures |
| Meeting history/details | Session actions, transcript paging, recording playback | Shared buttons; ordered transcript, time, paging navigation and native audio semantics |
| ConfirmDialog | Confirmation actions and focus | Preserve native showModal, Escape behavior, Cancel focus and focus restoration |
| BrowserSignInLink | Connection URL and instructions | Shared readonly Input; native disclosure |
| Browser sign-in | All controls in backend/src/main.tsx and backend/src/style.css | Independent browser bundle; centralized native controls, visible focus, 44px minimum height and synchronous submit guard |
| Marketing website | Header/Rail, links, download CTAs, privacy preferences, decorative meeting demo | Keep website components/tokens; visible focus and current-page navigation; decorative controls remain noninteractive |

The initial desktop inventory found 131 raw button sites, fourteen inputs, four selects, one textarea, two signal meters, one native dialog, a native audio player, and six disclosure pairs. Specialized controls such as navigation, switch buttons, source-tree checkboxes, and listbox options need their own semantics even when they share a primitive. Static labels do not need wrapper components merely to match Handy's file names.

## Findings addressed by the sweep

- Connected-source form submission must respect busy and disabled states, including Enter. Repeated record actions need record-specific accessible names, and empty searches need visible feedback.
- Custom selection controls need Arrow/Home/End navigation, Escape behavior and predictable trigger focus. Search fields and ordinary actions must sit outside listbox option containers.
- Disabled switches need a native disabled attribute. Recording playback rejection needs a handled error. Loading and page headings need their appropriate semantics.
- Tooltips need a description association, Escape dismissal and viewport-safe placement.
- Light-theme success, warning and danger text need AA contrast. Theme palette values should have one definition per light/dark pair, including explicit color-scheme overrides.
- Shared buttons, fields and notices need consistent focus, hover and disabled states while preserving Savvy's branding and transparent overlay.

Handy's implementations were reviewed rather than copied indiscriminately. Its custom dropdown and toggle have accessibility gaps that should not be reproduced in Savvy.

## Verification

The integrated desktop suite passed 156 tests in 14 files. TypeScript, Vite production build, ESLint, formatting, and the native CRM/document/outage fixture passed. Focused tests cover keyboard selection/focus, tooltip association and Escape, disabled switches, playback failure, primitive ref forwarding, form submission guards, empty search feedback, and semantic text contrast in both themes. ESLint now rejects raw desktop button/input/select/textarea elements outside the shared primitive implementation.

Brave rendered the updated Prepare and About views in both Light and Dark. The context popup separated the Add action from options and restored trigger focus after Escape. A help tooltip appeared and its text disappeared after Escape. These are browser-demo checks, not an installed managed call. Earlier Composio evidence remains in [the connected-sources record](connected-sources-2026-10.md); it does not substitute for checking the new issuer-scoped identity or the final native bundle.
