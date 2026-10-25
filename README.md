# Arcway — AI-assisted decision studio

Arcway is a static, browser-run prototype for making mathematical optimization easier to explore and explain. It demonstrates a weekly fulfillment-planning workflow: tune service priorities, test operational disruptions, inspect a solver-checked allocation, and export the plan.

## Try it locally

No build step or package installation is required. Serve the `public/` directory with any static web server, for example:

```bash
python3 -m http.server 8080 --directory public
```

Then open <http://localhost:8080>.

## What the demo does

- **Insight:** shows the scope and assumptions of the sample supplier, demand, and lane-cost data.
- **Interpretability:** explains the freight/service trade-off and surfaces regional shortfalls and active lanes.
- **Interactivity:** lets planners adjust service priority, edit model inputs, and explore or save what-if scenarios.
- **Improvisation:** models a Harbor supplier delay or a 12% demand spike and re-optimizes in one click.
- **Optimization:** runs a deterministic, exact min-cost-flow algorithm in the browser. Supplier capacities and regional demand accounting are enforced; unfilled demand is modeled explicitly and given a tunable penalty. The solver is separate from the assistant.
- **Export:** downloads the current allocation as CSV.

All planning values are synthetic. The app does not connect to company systems or send sample data anywhere in its default mode.

## AI modes and security

The default copilot is a small, transparent local demo assistant. It recognizes a limited set of what-if requests and explains the current solver output; it is **not a connected generative model**.

For optional generative responses, choose **Connect AI** and enter an OpenAI-compatible chat-completions endpoint, model, and your own key. The key is kept in page memory only (not local storage or the repository) and requests go directly from your browser to the endpoint. The provider must permit browser CORS requests. Prompts include the synthetic model inputs and current plan. The model may suggest only a few allowlisted scenario controls; the deterministic local solver then recomputes and checks the allocation. Never put a personal API key in this repository or a public page. For production use, put provider credentials behind an authenticated server-side proxy and review the security, privacy, and human-approval requirements for your organization.

## Publish on GitHub Pages

A GitHub Actions workflow in `.github/workflows/deploy-pages.yml` publishes `public/` to Pages when the session branch or `main` is pushed. In the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions** if it is not already configured. The published app uses relative asset paths and works from a project-page URL.

## Design inspiration

The interaction model is informed by the 4I framework—Insight, Interpretability, Interactivity, and Improvisation—in David Simchi-Levi, Tinglong Dai, Ishai Menache, and Michelle Xiao Wu, *“Democratizing Optimization with Generative AI”* (the SSRN paper supplied with this project). Arcway is an independent prototype and is not affiliated with the paper's authors or their institutions.
