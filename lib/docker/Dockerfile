# Shared base image for every skill in this plugin (phpstan, deptrac, ...).
# Deliberately generic: no tool, no project code baked in. A skill's
# run.sh detects the *target project's own* required PHP version and
# extensions (from its composer.json / composer.lock) and passes them as
# build args, so each project gets a standalone, purpose-built PHP runtime
# with exactly what it declares as required -- nothing more (no host PHP
# setup leaking in) and nothing missing (no "extension not loaded"
# surprises). The project itself (including the tool, e.g. vendor/bin/phpstan)
# is bind-mounted at container-run time, never baked into the image.
ARG PHP_VERSION=8.5
FROM php:${PHP_VERSION}-cli-alpine

# mlocati/docker-php-extension-installer: installs arbitrary named PHP
# extensions together with their correct system/library dependencies, and
# is a no-op for extensions already built into the base image -- avoids
# this plugin having to maintain its own extension-name -> apk-package
# mapping table.
ADD https://github.com/mlocati/docker-php-extension-installer/releases/latest/download/install-php-extensions /usr/local/bin/install-php-extensions
RUN chmod +x /usr/local/bin/install-php-extensions

# Space-separated extension names (without the "ext-" prefix), e.g.
# "intl bcmath gd". Left empty, this installs nothing beyond the base image.
ARG PHP_EXTENSIONS=""
RUN if [ -n "$PHP_EXTENSIONS" ]; then install-php-extensions $PHP_EXTENSIONS; fi

WORKDIR /app
