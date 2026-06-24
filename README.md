# Pawpaw Ko

A community-first pop-up gaming company and website for the trading card community. **Pawpaw Ko** hosts public **binders** — collections of cards each user wants to trade, sell, give away, or buy — filtered by boroughs, major subway stops, and local card shops so meet-ups are easy.

Live at **[pawpawko.com](https://pawpawko.com)**.

Games currently supported:
- One Piece TCG (primary)
- Pokémon TCG

## Stack

| Layer | Tech |
|---|---|
| Frontend | Vanilla HTML / CSS / JS (no framework) |
| Database, Auth, Storage (sleeve / background images) | [Supabase](https://supabase.com) |
| Card image storage / CDN | [Cloudflare R2](https://www.cloudflare.com/products/r2/) (WebP, two sizes) |
| Hosting + contact form | [Netlify](https://www.netlify.com/) |
| Data ingestion | Python — `requests`, `beautifulsoup4`, `boto3`, `Pillow`, `python-dotenv` |

## Local development

```sh
# from this directory
python -m http.server 8000
```

Open <http://localhost:8000>. Note: Netlify Forms and `_redirects` are not emulated by this server; use `netlify dev` if you need those.

## Repository layout

```
pawpawko-site/
├── *.html              # multi-page static site
├── css/styles.css      # all styling
├── js/                 # vanilla JS (Supabase client + per-page logic)
├── images/             # brand assets (logo, mascot, favicon)
├── scripts/            # Python ingestion + image migration tools
└── supabase-schema.sql # canonical database schema (idempotent)
```

## License & trademarks

The source code in this repository is offered under the **Functional Source License v1.1, MIT Future License** ([LICENSE](./LICENSE)) — you may use, modify, and redistribute it for any non-competing purpose, and each version converts to plain MIT after two years.

The **Pawpaw Ko** name, logo, and visual identity are trademarks of PAWPAW KO LLC and are **not** covered by the code license. See [TRADEMARKS.md](./TRADEMARKS.md) for details.

Card data and card images rendered by this site are properties of their respective rights holders (Bandai for One Piece TCG; The Pokémon Company for Pokémon TCG) and are used for interoperability only.

## Security

To report a security issue, see [SECURITY.md](./SECURITY.md). Please do not file public issues for sensitive vulnerabilities.

## Contact

General questions: **pawpaw_plays@pawpawko.com**
