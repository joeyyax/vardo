import type { ProbeTemplate } from "./types";

export const phpmyadmin: ProbeTemplate = {
  id: "phpmyadmin",
  name: "phpMyAdmin",
  description: "For apps that run phpMyAdmin. Lets it through and turns away its setup files.",
  version: 1,
  detect: [{ image: /(?:^|\/)phpmyadmin(?:[:@]|$)/i }, { path: "/phpmyadmin/", body: /<title>phpMyAdmin/i }],
  letThrough: ["/phpmyadmin", "/pma"],
  turnAway: [
    { kind: "prefix", value: "/phpmyadmin/setup", note: "phpMyAdmin setup wizard" },
    { kind: "exact", value: "/phpmyadmin/config.inc.php", note: "phpMyAdmin config" },
  ],
};
