# Security

## Report a problem

Report a security problem privately: on GitHub, open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for it.

## What Flowmap does on your computer

- **It answers on this computer only.** Flowmap listens on 127.0.0.1. It refuses a request whose host or origin is not localhost, which blocks web pages that try to reach it through DNS rebinding.
- **It runs your recipes' commands.** A recipe's `setup` and `session` are shell commands that Flowmap runs in your project's folder. Treat recipes as code: review changes to `.flowmap/states/` as you review scripts.
- **It keeps captures in your project.** Pictures and HTML snapshots go to `.flowmap/store/`, which set-up keeps out of git. Flowmap sends your captures, recipes and code to no server. The viewer loads its fonts from Google Fonts.
- **It never needs real accounts.** A session command should sign in a test account on a local or test database. Never put a real password or production data in a recipe.

## Supported versions

Fixes go into the newest release on npm.
