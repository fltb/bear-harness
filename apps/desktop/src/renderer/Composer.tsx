/**
 * Composer: a read-only input and disabled attach/send buttons. No fake
 * toast or simulated progress — this is a static visual in the framework.
 */
export function Composer(props: { placeholder: string }) {
	return (
		<form
			class="composer"
			onSubmit={(event) => {
				event.preventDefault();
			}}
		>
			<button type="button" class="circle" disabled aria-label="添加材料">
				＋
			</button>
			<textarea rows={1} readOnly placeholder={props.placeholder} aria-label="对极昼说点什么" />
			<button type="button" class="send" disabled aria-label="发送">
				➤
			</button>
		</form>
	);
}
