# web/  -  the single-page app (placeholder)

`dist/` is the **built** app. CDK copies it into the private web bucket at deploy time (a custom resource), together with a generated
`config.json` (region, Cognito pool and client ids), and invalidates the CloudFront cache.

In the infrastructure stage `dist/index.html` is a placeholder page, which also proves CloudFront, Origin Access Control and the
single-page-app routing work. The React app is built in the UI stage and its build output replaces `dist/`.

Do not put other files in `dist/`: everything in it is published.

How the app finds its backend: the app and the API share one CloudFront domain, so API calls go to the relative path `/api`, and
Cognito settings are read from `/config.json` at start-up. The same build therefore runs unchanged in every environment.
