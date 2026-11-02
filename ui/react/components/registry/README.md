# UI source provenance and maintenance

Rillo uses Kibo UI as the default source for shared composite components and shadcn conventions for local primitives. The registry is configured in `ui/components.json`. Checked-in code is reviewed and built offline; no component registry is contacted at runtime, in CI or during packaging.

| Components | Source | Retrieved | License | Local adaptation |
| --- | --- | --- | --- | --- |
| Status, StatusIndicator, StatusLabel | [Kibo Status registry](https://www.kibo-ui.com/r/status.json) | 2026-10-31 | MIT, shadcnblocks | Semantic CSS tokens, explicit labels; omit looping ping animation. |
| Pill | [Kibo Pill registry](https://www.kibo-ui.com/r/pill.json) | 2026-10-31 | MIT, shadcnblocks | Keep the Badge-based root; omit unused Avatar, Button, Delta and price decorations. Compact product typography. |
| Spinner | [Kibo Spinner registry](https://www.kibo-ui.com/r/spinner.json) | 2026-10-31 | MIT, shadcnblocks | Keep only Lucide throbber; accessible localized status, shared reduced-motion CSS. No upstream monorepo-only imports. |
| Button, Input, SearchField, Select, Dialog, Sheet, Popover, Switch, Tooltip, Badge, SegmentedControl | [shadcn architecture](https://ui.shadcn.com/docs), [Base UI](https://base-ui.com/react/overview/quick-start) | 2026-10-31 | Local adapters; Base UI MIT | One Base UI implementation, standard DOM/controlled-value APIs. Compact variants, labels, pending state, floating retained reader. No Radix or React Aria runtime. |
| Conversation, Message, MessageResponse | [Vercel AI Elements](https://github.com/vercel/ai-elements/tree/main/packages/elements/src) | 2026-08-29 | Apache-2.0, Vercel | Presentation-only; Streamdown and CJK plugin retained; existing runtime and paging retained; Teams uses Conversation scroll following and preserves manual history reading. No AI SDK, gateway, hosted service or Shiki plugin. |


| PromptInput, ChainOfThought, Task, Tool, InlineCitation, Agent, ModelSelector, Attachments | [Vercel AI Elements](https://github.com/vercel/ai-elements/tree/main/packages/elements/src) | 2026-11-02 | Apache-2.0, Vercel | Base UI composition for actual Run parts, public summaries, tool results, source links and definition snapshots. PromptInput hosts existing Tiptap Mention; attachments reference server files. No AI SDK transport, browser upload or fabricated reasoning. |
| Editor | [Kibo Editor registry](https://www.kibo-ui.com/r/editor.json) | 2026-11-01 | MIT, shadcnblocks | Tiptap 3 editor with stable member-ID Mention and local Command selector; omit unrelated document toolbars. |
| Kanban | [Kibo Kanban registry](https://www.kibo-ui.com/r/kanban.json) | 2026-11-01 | MIT, shadcnblocks | dnd-kit board with immutable updates, empty-column drops and ordering; persisted work items stay independent of collaboration Tasks and Runs. |

Shared Agent identity lives in `components/agents`, with offline DiceBear Micah avatars and stable member IDs. This is application identity presentation, not a second primitive library. Source licenses and attribution for AI Elements, DiceBear/Micah and PDF extraction are also retained in `server/vendor/THIRD_PARTY_NOTICES.md` and its accompanying license files.

The shadcn CLI was attempted for docs and registry inspection; its Node HTTPS requests failed in this environment. Exact official registry JSON was retrieved through HTTPS and reviewed instead. SHA256 of retrieved source JSON is recorded in the job audit. No existing components were blindly overwritten by a preset. The unused top-level `kibo-ui` npm package is not installed.

## Maintenance rules

- `components/ui` owns shared primitives; `components/kibo-ui` owns approved Kibo composites. Business components remain under features. Do not add a second primitive library.
- Reuse `lib/cn.ts`, `lib/motion.ts` and `styles/tokens.css`. Colors and durations belong to tokens, not a second palette.
- Before adding a registry item, inspect transitive dependencies, aliases and all exported code. Only install the dependencies its actual retained exports use; record source, date, license and adaptations.
- Keep accessible names, keyboard control, focus restoration, disabled/pending behavior and reduced-motion support. Keep offline single-file builds network independent.
- Historical dotUI-derived application CSS remains under its original MIT notice; the React Aria source components and bridge are replaced. Historical specs describe the earlier implementation, not current guidance.

License text is included in [UI notices](../../../THIRD_PARTY_NOTICES.md).
