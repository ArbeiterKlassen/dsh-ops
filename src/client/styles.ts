/** Host token palette and native controls; all styles stay inside this plugin's forms. */
export const SETTINGS_CSS = `
.ops-settings { color:var(--dsw-alias-label-primary,inherit); font:inherit; max-width:48rem; display:grid; gap:16px; }
.ops-settings p { margin:0; line-height:1.55; max-width:76ch; overflow-wrap:anywhere; }
.ops-settings h3 { font-size:1rem; margin:0; font-weight:600; }
.ops-settings fieldset { margin:0; padding:0; border:0; min-width:0; }
.ops-settings legend { font-weight:600; margin-bottom:10px; padding:0; }
.ops-settings-choice { display:flex; align-items:center; gap:10px; min-height:36px; cursor:pointer; }
.ops-settings-choice input { width:16px; height:16px; accent-color:var(--dsw-alias-button-primary-fill,#356be8); }
.ops-settings-choice code { overflow-wrap:anywhere; }
.ops-settings-columns { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:24px; }
.ops-settings-field { display:grid; gap:8px; }
.ops-settings input[type=text], .ops-settings input[type=number] { box-sizing:border-box; max-width:100%; border:1px solid var(--dsw-alias-border-l3,#888); background:transparent; color:inherit; border-radius:var(--dsw-radius-sm,8px); padding:8px 10px; font:inherit; }
.ops-settings input[type=number] { width:7rem; }
.ops-settings button { font:inherit; color:inherit; background:transparent; padding:8px 14px; border:1px solid var(--dsw-alias-border-l3,#888); border-radius:var(--dsw-radius-md,12px); cursor:pointer; min-height:36px; }
.ops-settings button:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover,#8882); }
.ops-settings button.ops-settings-primary { background:var(--dsw-alias-button-primary-fill,#356be8); color:var(--dsw-alias-label-primary-foreground,#fff); border-color:transparent; }
.ops-settings :is(button,input):focus-visible { outline:2px solid var(--dsw-alias-button-primary-fill,#356be8); outline-offset:3px; }
.ops-settings :disabled { opacity:.5; cursor:not-allowed; }
.ops-settings-actions { display:flex; flex-wrap:wrap; gap:10px; }
.ops-settings-note { color:var(--dsw-alias-label-secondary,inherit); }
.ops-settings-runtime { border-top:1px solid var(--dsw-alias-border-l3,#888); padding-top:20px; margin-top:8px; }
.ops-settings-preview { border:1px solid var(--dsw-alias-border-l3,#888); border-radius:var(--dsw-radius-md,12px); padding:16px; display:grid; gap:12px; }
.ops-settings-preview ul { margin:0; padding-left:20px; line-height:1.55; overflow-wrap:anywhere; }
@media(max-width:440px) { .ops-settings-columns { grid-template-columns:1fr; gap:20px; } }
`
