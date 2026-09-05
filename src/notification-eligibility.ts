/** The sole run transition that warrants notifying the operator. */
export interface NotificationTransition {
	fromState: string | null;
	toState: string;
}

/**
 * A notification is only an operator-block alert after the runtime has
 * exhausted its internal cycle resolution and actually entered waiting-user.
 */
export function needsOperatorNotification(event: NotificationTransition): boolean {
	return event.fromState !== event.toState && event.toState === 'waiting-user';
}
