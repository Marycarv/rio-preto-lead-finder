<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

Lead sources live in src/lib/sources/* and return RawLead[]; add new sources there so import stays modular.
Leads are user-scoped (RLS on user_id); server functions use requireSupabaseAuth.
AI never sends messages: it only drafts; user approves and opens WhatsApp manually (product requirement).
