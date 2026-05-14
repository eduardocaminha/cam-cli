#!/bin/bash
set +m

CYAN='\033[1;36m'
GREEN='\033[1;32m'
BOLD='\033[1m'
DIM='\033[2m'
RST='\033[0m'

CAM_CONFIG_PANE="${CAM_CONFIG_PANE:-}"
CAM_ORCH_PROMPT_FILE="${CAM_ORCH_PROMPT_FILE:-.claude/.cam-orchestrator-prompt.txt}"
CAM_ORCH_PANE=""

show_initial() {
	clear
	printf "${CYAN}  cam init — setup running...${RST}\n\n"
	printf "  ${BOLD}c${RST}  switch to config pane (interact)\n"
	printf "  ${BOLD}v${RST}  open read-only viewer\n"
	printf "  ${BOLD}q${RST}  close this menu\n\n"
	printf "${DIM}  waiting for CAM_SETUP_STATUS=DONE...${RST}\n"
}

show_post() {
	clear
	printf "${GREEN}  ✓ cam setup complete${RST}\n\n"
	printf "  Orchestrator launched in the new pane.\n"
	printf "  Config pane is still alive for review.\n\n"
	printf "  ${BOLD}o${RST}  switch to orchestrator pane\n"
	printf "  ${BOLD}c${RST}  switch to config pane\n"
	printf "  ${BOLD}k${RST}  close (kill) the config pane\n"
	printf "  ${BOLD}q${RST}  close this menu\n"
}

handoff() {
	# Spawn the orchestrator pane immediately to the right of the config pane.
	CAM_ORCH_PANE=$(tmux split-window \
		-h -t "${CAM_CONFIG_PANE}" -l 50% -P -F '#{pane_id}' \
		"bash -c 'claude --permission-mode bypassPermissions \"\$(cat ${CAM_ORCH_PROMPT_FILE})\"'") || CAM_ORCH_PANE=""
}

state=initial
show_initial

while true; do
	if [[ "${state}" == "initial" ]]; then
		# 2s timeout lets the polling fire even if the user is idle.
		read -rsn1 -t 2 key
		case "${key}" in
			c|C) tmux select-pane -t "${CAM_CONFIG_PANE}" ;;
			v|V) tmux split-window -v -l 12 "tmux pipe-pane -t '${CAM_CONFIG_PANE}' -o 'cat >> /tmp/cam-config.log'; tail -f /tmp/cam-config.log" ;;
			q|Q) exit 0 ;;
		esac
		# Poll for DONE in the config pane's full scrollback.
		if tmux capture-pane -t "${CAM_CONFIG_PANE}" -p -S - 2>/dev/null | grep -q "CAM_SETUP_STATUS=DONE"; then
			handoff
			state=post
			show_post
		fi
	else
		read -rsn1 key
		case "${key}" in
			o|O) [[ -n "${CAM_ORCH_PANE}" ]] && tmux select-pane -t "${CAM_ORCH_PANE}" ;;
			c|C) tmux select-pane -t "${CAM_CONFIG_PANE}" ;;
			k|K) tmux kill-pane -t "${CAM_CONFIG_PANE}" ;;
			q|Q) exit 0 ;;
		esac
	fi
done
