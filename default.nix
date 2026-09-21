{ pkgs ? import <nixpkgs> {} }:

let
  metadata = builtins.fromJSON (builtins.readFile ./gnome-extension/metadata.json);
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "gnome-shell-extension-pi-traffic-light";
  version = toString metadata.version;

  src = ./gnome-extension;

  nativeBuildInputs = [ pkgs.gettext ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    for po in po/*.po; do
      lang=$(basename "$po" .po)
      mkdir -p "locale/$lang/LC_MESSAGES"
      msgfmt -o "locale/$lang/LC_MESSAGES/${metadata."gettext-domain"}.mo" "$po"
    done
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm644 -t $out/share/gnome-shell/extensions/${metadata.uuid} \
      $src/metadata.json $src/extension.js $src/stylesheet.css
    cp -r locale $out/share/gnome-shell/extensions/${metadata.uuid}/locale
    runHook postInstall
  '';

  meta = {
    description = "Traffic-light indicator for AI coding agent sessions (Claude Code, Pi) in the GNOME top bar";
    homepage = "https://github.com/mavenel/pi-traffic-light";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
