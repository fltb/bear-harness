export function webLaunchArguments(soak) {
	return ["--no-install", "rsbuild", soak ? "preview" : "dev"];
}
